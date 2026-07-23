import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { pathForTerminalDrop } from '../../lib/dragPaste';
import { handleTerminalKeyEvent } from '../../lib/terminalClipboard';
import { findPaneWithTab } from '../../lib/layoutTree';
import {
  openFileLink,
  createFilePathLinkProvider,
} from '../../lib/filePathLinks';

// "xterm.js" is a library that draws a fully working terminal screen (with
// a blinking cursor, colored text, scrollback, etc.) inside a web page —
// it's the same technology that powers the terminal built into VS Code.
// This file connects that on-screen terminal display to the REAL shell
// process running in the background (see terminal.js), so what you type
// here actually reaches a real command line, and whatever that command
// line prints shows up here.
//
// ── How this file keeps terminals from getting garbled ──
//
// The single most important idea in this file: the on-screen terminal
// widget for each tab is created ONCE and then kept alive for as long as
// the shell process is alive — even while its tab is hidden (you switched
// to another tab or workspace). We simply unplug its little piece of the
// page (a <div>) and plug it back in when you return.
//
// The old approach destroyed the widget every time you switched away and
// tried to rebuild the screen from a saved copy when you came back. That
// had two fatal flaws that showed up as scrambled/mostly-blank terminals:
//   1. Anything printed while you were away never reached the (destroyed)
//      widget, so the rebuilt screen was out of date — and full-screen
//      programs (like an interactive CLI tool) would keep drawing on top
//      of a screen state that no longer matched, producing garbage.
//   2. Live output could arrive and get drawn BEFORE the saved copy was
//      replayed, interleaving old and new text out of order.
// Keeping the widget alive makes both problems impossible: output keeps
// flowing into the (hidden) widget the whole time, in order, and there is
// nothing to "restore" when you come back — the screen is simply still
// correct.

// Color scheme for the terminal, matching the rest of the app's dark theme
// (see design.html) plus the standard 16 terminal colors (used by
// programs that print colored text, like "ls --color" or a colorful
// command-line tool).
const THEME = {
  background: '#16171b',
  foreground: '#e8eaf0',
  cursor: '#e8eaf0',
  cursorAccent: '#16171b',
  selectionBackground: '#2a2d35',
  selectionForeground: '#e8eaf0',
  selectionInactiveBackground: '#2c2f37',
  black: '#16171b',
  red: '#f2434f',
  green: '#4ec9b0',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#9cdcfe',
  white: '#e8eaf0',
  brightBlack: '#6a6a6a',
  brightRed: '#f14c4c',
  brightGreen: '#6a9955',
  brightYellow: '#d7ba7d',
  brightBlue: '#9cdcfe',
  brightMagenta: '#d7a8d7',
  brightCyan: '#b5cea8',
  brightWhite: '#ffffff',
};

// The renderer's OS never changes while the app is running, so we only
// need to ask the background process for it once — every terminal pane
// that opens after the first one just reuses this same cached answer
// instead of asking again.
let platformInfoPromise = null;
function getPlatformInfo() {
  if (!platformInfoPromise) platformInfoPromise = window.terminals.platformInfo();
  return platformInfoPromise;
}

// ── The session cache ──
//
// One "session" per terminal tab, keyed by the tab's id. A session owns:
//   - host:     the <div> the terminal is drawn into. This div gets moved
//               between being attached to the page (tab visible) and
//               detached (tab hidden) — the terminal itself never dies.
//   - term:     the live xterm.js Terminal widget.
//   - fitAddon: the helper that resizes the widget to fill its container.
//   - termId:   which background shell process this session talks to.
//   - queue:    while we're still catching up on saved output during
//               setup, live output is parked here (instead of drawn
//               immediately) so nothing gets drawn out of order. Set to
//               null once caught up, meaning "draw live output directly".
//   - dead:     true once the shell process has exited.
//   - mounted:  whether the session's host div is currently on screen.
const sessions = new Map();

// Finds the session that is connected to a given background shell id.
function sessionByTermId(termId) {
  for (const session of sessions.values()) {
    if (session.termId === termId) return session;
  }
  return null;
}

// Formats text before writing it into the terminal shell process.
//
// Interactive CLI applications (like agy / Antigravity, Claude Code, etc.)
// support "bracketed paste mode". When text is wrapped in special escape
// sequences (\x1b[200~ ... \x1b[201~), the CLI application knows the text
// was pasted all at once. This lets agy collapse multiline text into neat
// "[Pasted Text #1 +100 lines]" blocks rather than executing every newline
// as an ENTER keystroke and overflowing the prompt buffer.
function formatPasteForTerminal(term, text) {
  if (!text) return '';
  // clipboard.readText() is async (returns a Promise). If it ever lands here
  // by accident via `||`, bail out instead of crashing on .replace().
  if (typeof text !== 'string') return '';

  // Use real newline characters (\n), NOT carriage returns (\r).
  //
  // Why this matters: xterm.js historically turns pasted newlines into \r, but
  // Windows TUI apps built on ultraviolet/bubbletea (agy / Antigravity) treat
  // \n as the line break inside a bracketed paste. Their own Win32 input path
  // even converts Enter keys to '\n' while collecting paste bytes. If we send
  // only \r, the paste markers can arrive but the TUI still won't collapse the
  // paste into a "[Pasted text #N +N lines]" chip the way Windows Terminal does.
  const normalized = text.replace(/\r\n|\r/g, '\n');
  if (term?.modes?.bracketedPasteMode || text.includes('\n') || text.includes('\r')) {
    return `\x1b[200~${normalized}\x1b[201~`;
  }
  return normalized;
}

// ── Clickable links in terminal output ──
//
// Two separate systems work together here:
//
//   1. WebLinksAddon (default rules) — underlines ordinary web URLs like
//      "https://example.com" and opens them in the in-app browser.
//
//   2. Our own file-path link provider (see filePathLinks.js) — underlines
//      printed file paths like "demo/index.html" or "C:\Users\you\a.txt"
//      and opens them in the in-app editor. We deliberately do NOT reuse
//      WebLinksAddon for file paths: that addon always runs a "is this a
//      real URL?" filter after its regex match, which silently throws away
//      every ordinary file path (they aren't valid URLs). That was why
//      Claude Code's blue file names used to do nothing when clicked.
//
//   3. Native OSC 8 hyperlinks — some modern CLI tools (Claude Code when
//      it detects hyperlink support) wrap text in an invisible "this is a
//      link, and its REAL target is X" tag. xterm.js parses those natively
//      via `linkHandler` below; we route http(s) to the browser and
//      everything else (usually a file:// URI) to the editor.

// Called when a web-URL link (matched by the default WebLinksAddon) is
// clicked in a terminal: opens it in the in-app browser, reusing a browser
// tab already open in the SAME split pane as this terminal if there is one.
function openUrlLink(session, url) {
  const workspace = session.workspace;
  if (!workspace?.layout) return;
  const paneId = findPaneWithTab(workspace.layout, session.tabId)?.id;
  if (!paneId) return;
  workspace.openUrlInPane(paneId, url);
}

// Routes a native OSC 8 hyperlink click: web URLs go to the browser,
// anything else is treated as a file path/URI for the editor (only if it
// turns out to actually exist — see openFileLink in filePathLinks.js).
function handleNativeHyperlink(session, targetText) {
  if (/^https?:\/\//i.test(targetText)) {
    openUrlLink(session, targetText);
  } else {
    openFileLink(session, targetText);
  }
}

// Fully tears down a session: destroys the on-screen widget and forgets
// it. Only called once the shell process is gone AND the tab is no longer
// on screen — never for a mere tab switch.
function disposeSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  session.term.dispose();
}

// One single, app-wide subscription to terminal output and exit events,
// shared by every terminal tab. Each event carries the id of the shell it
// came from, and we route it to that shell's session — whether or not that
// session's tab is currently visible. This is what lets hidden terminals
// keep receiving output correctly.
let globalListenersWired = false;
function wireGlobalListeners() {
  if (globalListenersWired) return;
  globalListenersWired = true;

  window.terminals.onData((id, data) => {
    const session = sessionByTermId(id);
    if (!session) return;
    if (session.queue) {
      // Still replaying saved history — park this chunk so it gets drawn
      // strictly AFTER the history, in the right order.
      session.queue.push({ id, data });
    } else {
      writeWithAck(session.term, id, data);
    }
  });

  window.terminals.onExit((id) => {
    const session = sessionByTermId(id);
    if (!session) return;
    session.dead = true;
    session.term.write('\r\n[Process exited]\r\n');
    // If the tab isn't on screen (e.g. it was just closed, which kills the
    // shell), clean the widget up now. If it IS on screen, leave the
    // message visible; cleanup happens when the pane unmounts.
    if (!session.mounted) disposeSession(session.tabId);
  });
}

// Builds a brand-new session for a tab: creates the widget, connects it to
// its shell process (reconnecting to a still-running one, or restoring
// saved history and starting a fresh shell after an app restart), and
// wires typing to the shell. The host div must already be attached to the
// page before this is called, so the widget can measure itself correctly.
async function createSession(tabId, host, savedTerminalId, cwd, onNewTerminalId) {
  // Ask the background process what OS (and Windows build) we're running
  // on before creating the terminal — see the windowsPty option below.
  const platformInfo = await getPlatformInfo();

  // Declared before the Terminal itself, because the `linkHandler` option
  // passed to the Terminal's constructor (just below) needs to be able to
  // reach this tab's session object — but that object isn't built until
  // just after the terminal is. Its handlers only ever actually RUN later,
  // in response to a real click, by which point `session` further down has
  // long since been assigned — a plain closure over this variable is all
  // that's needed to bridge the two.
  let session = null;

  const term = new Terminal({
    theme: THEME,
    fontFamily: '"Cascadia Code", ui-monospace, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    // IMPORTANT: convertEol must stay OFF. It rewrites "newline" characters
    // in the output, which is fine for plain logs but actively corrupts
    // the precise cursor-movement commands that full-screen programs (text
    // editors, interactive CLI tools) use to draw themselves — one of the
    // things that made terminals look scrambled before.
    convertEol: false,
    allowTransparency: false,
    // The Unicode11 addon below (which teaches the terminal correct
    // character-width rules) uses a feature of xterm.js that is still
    // labeled "experimental" upstream. xterm.js refuses to let any
    // experimental feature run unless we explicitly opt in here — without
    // this flag, the terminal pane throws immediately and never renders.
    allowProposedApi: true,
    scrollback: 5000, // How many lines of history you can scroll back through.
    // On Windows, the real shell process talks to us through "ConPTY"
    // (Windows' terminal emulation layer), which sometimes splits a
    // single line-ending across two separate chunks of output. Without
    // telling xterm.js it's talking to ConPTY, it can misread that
    // split and draw garbled or duplicated-looking lines — this option
    // tells it to expect that and handle it correctly.
    windowsPty:
      platformInfo.platform === 'win32'
        ? { backend: 'conpty', buildNumber: platformInfo.windowsBuild }
        : undefined,
    // Intercepts real OSC 8 terminal hyperlinks (see the big comment on
    // handleNativeHyperlink above) instead of letting xterm.js fall back to
    // its own default behavior of calling window.open() on click, which is
    // what was popping open a bare, chrome-less new Electron window.
    linkHandler: {
      // OSC 8 links aren't required to be http(s) — e.g. a "file://" link
      // to a local file. Without this flag, xterm.js silently drops any
      // link whose target isn't http(s) rather than ever calling activate()
      // for it, which would make local-file OSC 8 links do nothing at all.
      allowNonHttpProtocols: true,
      activate: (_event, targetText) => {
        if (session) handleNativeHyperlink(session, targetText);
      },
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  // Teach the terminal the modern Unicode rules for how WIDE each
  // character is on screen. Emoji and many Asian characters take up two
  // columns instead of one; if the terminal guesses those widths wrong,
  // its idea of where the cursor is slowly drifts away from the program's
  // idea, and lines start rendering subtly (or badly) misaligned. Claude
  // Code and modern CLI tools print these characters constantly.
  const unicode11 = new Unicode11Addon();
  term.loadAddon(unicode11);
  term.unicode.activeVersion = '11';

  term.open(host);

  // Intercept native browser paste events on the terminal container in the capture phase
  // before xterm's internal listener receives them. This prevents raw paste behavior
  // (which omits bracketed paste escape sequences), and instead explicitly passes the text
  // through formatPasteForTerminal. This guarantees bracketed paste markers
  // (\x1b[200~ ... \x1b[201~) are sent for multiline pastes so agy displays them as
  // "[Pasted Text #1 +100 lines]".
  host.addEventListener(
    'paste',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Prefer the paste event's own clipboard data (sync). Fall back to our
      // IPC clipboard helper only if the event carried nothing — and note that
      // readText() is async, so formatPasteForTerminal ignores non-strings.
      const text = e.clipboardData?.getData('text/plain') || '';
      if (text && session?.termId && !session.dead) {
        const formatted = formatPasteForTerminal(term, text);
        window.terminals.write(session.termId, formatted);
      } else if (!text && session?.termId && !session.dead) {
        // Rare fallback: some Electron contexts leave clipboardData empty.
        // Read the OS clipboard asynchronously and paste once it arrives.
        window.clipboard.readText().then((clipText) => {
          if (!clipText || !session?.termId || session.dead) return;
          const formatted = formatPasteForTerminal(term, clipText);
          window.terminals.write(session.termId, formatted);
        });
      }
    },
    true
  );

  // Use the GPU-accelerated renderer (the same one VS Code uses) instead
  // of the default, slower DOM-based one — this makes fast scrolling
  // output dramatically smoother. Loaded AFTER term.open(), as the addon
  // requires. If the graphics context is ever lost (driver hiccup, GPU
  // reset) or WebGL isn't available at all, we simply fall back to the
  // default renderer — slower, but always works.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
    });
    term.loadAddon(webgl);
  } catch {
    // WebGL unavailable — the built-in renderer is used automatically.
  }

  // Assigns to the `session` variable declared above (not a fresh `const`)
  // — the linkHandler wired into the Terminal's constructor options above
  // already closed over that variable, and is now able to see this object
  // once a click actually happens.
  session = {
    tabId,
    host,
    term,
    fitAddon,
    // The folder this terminal's shell was started in — used by
    // openFileLink above to turn a RELATIVE printed path (like
    // "demo/index.html") into a full one it can actually check and open.
    // (If the user later `cd`s somewhere else inside the shell, we have no
    // way of knowing — the starting folder is our best available guess, and
    // the exists-check in openFileLink keeps a wrong guess harmless.)
    cwd: cwd || null,
    termId: savedTerminalId || null,
    queue: [], // Park live output until we've finished catching up below.
    dead: false,
    mounted: true,
    // The latest `workspace` object passed down from whichever TerminalPane
    // component currently has this tab mounted. This session object lives
    // for as long as the shell process does (see the big comment at the
    // top of this file), which can outlive any single component instance —
    // so instead of the link-click handlers below closing over a `workspace`
    // that could go stale after a tab switch/remount, they read it fresh
    // off this field each time (kept up to date by TerminalPane's render
    // effect further down).
    workspace: null,
  };
  sessions.set(tabId, session);

  // Recognizes web links (e.g. "https://example.com") printed in the
  // terminal's output, underlines them, and opens them in the in-app
  // browser when clicked. Uses the addon's own default URL-matching rules
  // (and its built-in "must be a real URL" filter, which is correct here).
  const urlLinks = new WebLinksAddon((_event, uri) => openUrlLink(session, uri));
  term.loadAddon(urlLinks);

  // Recognizes file paths printed as plain text (see filePathLinks.js for
  // why this is a custom provider instead of a second WebLinksAddon). The
  // provider reads `session` live via getSession so it always sees the
  // current workspace/cwd, even after this tab has been remounted.
  const filePathProvider = createFilePathLinkProvider(() => sessions.get(tabId));
  // registerLinkProvider returns a small "disposable" handle; xterm cleans
  // it up automatically when the terminal itself is disposed, so we don't
  // need to hold onto it ourselves.
  term.registerLinkProvider(filePathProvider);

  // Whenever the user types something into the on-screen terminal, send
  // those exact keystrokes to the real background shell process.
  term.onData((data) => {
    if (session.termId && !session.dead) window.terminals.write(session.termId, data);
  });

  // Smart copy/paste: Ctrl+C copies the current selection (and, since a
  // selection exists, does NOT also send its usual SIGINT to the shell);
  // with nothing selected, Ctrl+C is left completely alone and behaves
  // exactly as it always has. Ctrl+V always pastes using term.paste(text)
  // so that xterm.js can handle bracketed paste mode (\x1b[200~ ... \x1b[201~)
  // for interactive CLI tools (like agy / Antigravity CLI).
  term.attachCustomKeyEventHandler((event) =>
    handleTerminalKeyEvent(event, {
      hasSelection: () => term.hasSelection(),
      getSelection: () => term.getSelection(),
      copyText: (text) => window.clipboard.writeText(text),
      readClipboardText: () => window.clipboard.readText(),
      pasteText: (text) => {
        if (session.termId && !session.dead) {
          const formatted = formatPasteForTerminal(term, text);
          window.terminals.write(session.termId, formatted);
        }
      },
    })
  );

  // Give the page one frame to lay the host div out at its real size, then
  // size the terminal to fill it — otherwise the very first size we'd
  // report to the shell would be the built-in default (80x24), not the
  // real on-screen size, and text would wrap at the wrong width.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  safeFit(session);

  if (savedTerminalId) {
    // This tab already had a shell before. Ask the background process
    // whether that shell is still running.
    const { alive, buffer } = await window.terminals.attach(savedTerminalId);
    if (alive) {
      // Still running (e.g. the window was reloaded). Draw everything it
      // printed so far, then release any live output that arrived while we
      // were drawing — strictly in that order, so nothing interleaves.
      if (buffer) term.write(buffer);
      flushQueue(session);
      // Nudge the shell with a tiny resize "wiggle" (one row smaller, then
      // back). This makes Windows' ConPTY and any full-screen program
      // running inside the shell repaint themselves from scratch, which
      // cleans up anything the flat history replay above couldn't
      // faithfully reconstruct (full-screen layouts, cursor position).
      const { cols, rows } = term;
      if (cols && rows > 1) {
        window.terminals.resize(savedTerminalId, cols, rows - 1);
      }
      syncSize(session);
      return session;
    }
    // The whole app was restarted, so the old shell process is gone. Show
    // the history we saved to disk, a small divider, then start fresh.
    if (buffer) {
      term.write(buffer);
      term.write('\r\n\x1b[2m── restored from previous session ──\x1b[0m\r\n\r\n');
    }
  }

  // No previous shell to reconnect to — start a fresh one in the
  // workspace's own folder, and let the caller remember its id on this
  // tab so future reopens can reconnect to it.
  const id = await window.terminals.create(cwd);
  session.termId = id;
  flushQueue(session);
  onNewTerminalId(id);
  syncSize(session);
  return session;
}

// Draws one chunk of live output and, once the terminal has actually
// finished processing/drawing it, confirms that back to the background
// process (an "ack"). That confirmation drives the flow control described
// in terminal.js: it's how the app can safely pause a shell that's
// printing faster than the screen can draw, instead of drowning in output
// (which previously caused lag and dropped/garbled text on huge prints).
function writeWithAck(term, termId, data) {
  term.write(data, () => {
    window.terminals.ack(termId, data.length);
  });
}

// Draws any output that was parked during setup, then switches the session
// to "draw live output directly" mode.
function flushQueue(session) {
  const parked = session.queue;
  session.queue = null;
  if (parked) {
    for (const chunk of parked) writeWithAck(session.term, chunk.id, chunk.data);
  }
}

// Tells the background shell process how many rows/columns of text fit on
// screen right now, so it can wrap output correctly (the same way a real
// terminal window resizing affects how text wraps).
function syncSize(session) {
  const { cols, rows } = session.term;
  if (session.termId && !session.dead && cols && rows) {
    window.terminals.resize(session.termId, cols, rows);
  }
}

// Resizes the widget to fill its container — but ONLY if the container has
// a sensible size right now. During layout changes (opening/closing panes,
// dragging dividers, hiding tabs) the container can momentarily be tiny or
// zero-sized; blindly fitting then would shrink the terminal to a couple
// of columns wide, and Windows' ConPTY would permanently re-wrap all the
// text to that absurd width — this was the cause of terminals showing only
// 2-letter stubs of every line. Ignoring degenerate sizes fixes that; the
// resize watcher will fit again once the container has a real size.
function safeFit(session) {
  if (!session || !session.host) return;
  const rect = session.host.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 40) return;
  const dims = session.fitAddon.proposeDimensions();
  if (!dims || !dims.cols || !dims.rows || dims.cols < 8 || dims.rows < 2) return;
  if (dims.cols !== session.term.cols || dims.rows !== session.term.rows) {
    session.fitAddon.fit();
  }
}

export default function TerminalPane({ tab, workspace }) {
  // A reference to the empty <div> below where the terminal's host div
  // gets plugged in.
  const containerRef = useRef(null);

  // Keeps this tab's session pointed at the LATEST `workspace` object on
  // every single render (deliberately with no dependency array, so this
  // runs after every render, not just the first one). This is what the
  // link-click handlers (openUrlLink/openFileLink above) read from — see
  // the big comment on the session's `workspace` field for why a one-time
  // assignment wouldn't be enough (this component can unmount/remount
  // while the session itself lives on).
  useEffect(() => {
    const session = sessions.get(tab.id);
    if (session) session.workspace = workspace;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    wireGlobalListeners();

    // True once this effect's cleanup has run (e.g. the tab was switched
    // away from before setup finished) — the async setup below checks this
    // so it can't finish "late" and set up a terminal nobody wants.
    let cancelled = false;
    let session = sessions.get(tab.id) || null;

    if (session) {
      // This tab's terminal already exists (you switched away and came
      // back). Just plug its drawing surface back into the page — the
      // screen contents are already fully up to date, because the session
      // kept receiving output the whole time it was hidden.
      container.appendChild(session.host);
      session.mounted = true;
      // Point the session at the CURRENT workspace object right away (not
      // only on a later re-render). Link-click handlers read this field to
      // open files/URLs in the right pane; if we left it stale/null, a
      // click would silently do nothing.
      session.workspace = workspace;
      // The pane may be a different size than when we left; refit once the
      // layout has settled.
      requestAnimationFrame(() => {
        if (cancelled || !session) return;
        safeFit(session);
        syncSize(session);
        // Repaint quirk: after being re-attached to the page, ask the
        // widget to redraw everything so nothing looks stale.
        session.term.refresh(0, session.term.rows - 1);
      });
    } else {
      // First time this tab's terminal appears (this app session). Build
      // its host div, plug it in, and create the session.
      const host = document.createElement('div');
      host.style.width = '100%';
      host.style.height = '100%';
      container.appendChild(host);
      createSession(
        tab.id,
        host,
        tab.config?.terminalId || null,
        workspace.workspace?.path,
        // Called if a brand-new shell had to be started: remember its id
        // on this tab so future reopens reconnect to it.
        (newId) => {
          workspace.updateTab(tab.id, { config: { ...tab.config, terminalId: newId } });
        }
      ).then((created) => {
        session = created;
        // createSession finishes asynchronously — sometimes without any
        // React state update that would re-run the "keep workspace fresh"
        // effect above (e.g. reconnecting to a still-running shell). Stamp
        // workspace on immediately so the very first link click already
        // has somewhere to open the file/URL.
        session.workspace = workspace;
        if (cancelled) {
          // The tab was hidden again before setup finished. The session
          // stays alive (its shell is running) — just record that it's not
          // on screen, and unplug its host div.
          session.mounted = false;
          if (host.parentNode) host.parentNode.removeChild(host);
        }
      }).catch((err) => {
        session = sessions.get(tab.id) || null;
        if (session) {
          session.dead = true;
          session.term.write(`\r\n\x1b[31mCouldn't start this terminal: ${err.message}\x1b[0m\r\n`);
        } else {
          host.textContent = `Couldn't start this terminal: ${err.message}`;
          host.style.cssText +=
            'display:flex;align-items:center;justify-content:center;color:#9aa1ad;font-size:13px;padding:16px;text-align:center;';
        }
      });
    }

    // Don't touch the terminal size while a drag is in flight — refitting
    // on every frame makes ConPTY rewrap the buffer continuously and the
    // text visibly churns. We wait until the size has been stable for 80
    // milliseconds before actually resizing anything, which feels instant
    // to the user but avoids that flicker.
    let fitTimer = null;
    let fitRaf = null;
    const triggerFit = () => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = null;
        if (!session || cancelled) return;
        if (fitRaf) cancelAnimationFrame(fitRaf);
        // Run safeFit inside a requestAnimationFrame so that measuring the DOM
        // bounds happens cleanly at the start of the next frame, avoiding
        // browser layout thrashing during active window resizes.
        fitRaf = requestAnimationFrame(() => {
          safeFit(session);
          syncSize(session);
        });
      }, 80);
    };

    const resizeObserver = new ResizeObserver(() => {
      triggerFit();
    });
    resizeObserver.observe(container);

    // Watch for High-DPI monitor scaling changes (e.g., dragging the window
    // from a 4K 200% screen to a 1080p 100% display). When the pixel ratio
    // changes, refresh the terminal canvas so text stays razor-sharp!
    const handleDpiChange = () => {
      if (session && !cancelled) {
        safeFit(session);
        session.term.refresh(0, session.term.rows - 1);
      }
    };
    window.addEventListener('resize', handleDpiChange);

    // Cleanup, run when this pane is hidden (tab switch), moved, or
    // closed: stop watching for resizes and unplug the terminal's drawing
    // surface from the page. Crucially, the terminal widget and its shell
    // process both stay alive — output keeps flowing into the hidden
    // widget so it's still perfectly up to date whenever you come back.
    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleDpiChange);
      if (fitTimer) clearTimeout(fitTimer);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      if (session) {
        session.mounted = false;
        if (session.host.parentNode) session.host.parentNode.removeChild(session.host);
        // If the shell already exited (e.g. this tab was closed, which
        // kills its shell), there is nothing to come back to — fully
        // dispose of the widget now.
        if (session.dead) disposeSession(session.tabId);
      }
    };
  }, [tab.id]);

  // Handles a file dropped in from an Editor pane's Explorer (see
  // EditorPane.jsx's draggable file rows), or a URL dropped in from a
  // Browser pane's address bar: types the dropped path/URL into the shell
  // at wherever its own cursor currently is, using term.paste so bracketed
  // paste mode is respected.
  const handleDrop = (e) => {
    e.preventDefault();
    const dropped = e.dataTransfer.getData('text/plain');
    if (!dropped) return;
    const session = sessions.get(tab.id);
    if (!session || !session.termId || session.dead) return;
    const formatted = formatPasteForTerminal(session.term, pathForTerminalDrop(dropped));
    window.terminals.write(session.termId, formatted);
  };

  return (
    <div
      ref={containerRef}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className="terminal-pane h-full w-full min-h-0 min-w-0 flex-1 overflow-hidden bg-app"
    />
  );
}
