import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';

// "xterm.js" is a library that draws a fully working terminal screen (with
// a blinking cursor, colored text, scrollback, etc.) inside a web page —
// it's the same technology that powers the terminal built into VS Code.
// This file connects that on-screen terminal display to the REAL shell
// process running in the background (see terminal.js), so what you type
// here actually reaches a real command line, and whatever that command
// line prints shows up here.

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

// Keeps a full, faithful snapshot of each terminal's on-screen contents —
// colors, cursor position, and (crucially) whether a full-screen program
// like vim or htop had taken over the display — captured the instant its
// pane goes away (e.g. you switch to a different workspace, which throws
// away this component and its on-screen xterm.js widget, even though the
// real shell process keeps running in the background).
//
// This exists because the background shell process only remembers its
// output as a flat, raw stream of text (see terminal.js). Replaying that
// raw stream into a brand-new, blank terminal widget can't correctly
// reconstruct anything that depended on the OLD terminal's state — like a
// full-screen program's layout — and can visibly show up as scrambled
// text. A proper snapshot (made with xterm.js's own "serialize" addon)
// instead captures a faithful description of exactly what was on screen,
// which restores correctly. This only lives in memory for as long as the
// app is running (cleared on restart) — that's fine, since after a full
// restart there's no live screen left to snapshot anyway, and we fall back
// to the raw output log in that case instead (see startTerminal below).
const terminalSnapshots = new Map();

export default function TerminalPane({ tab, workspace }) {
  // A reference to the empty <div> below where xterm.js will draw the
  // actual terminal screen.
  const containerRef = useRef(null);
  // References to the live xterm.js Terminal object and its "FitAddon"
  // (a helper that resizes the terminal to exactly fill its container),
  // kept outside of React state since we manage them imperatively.
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  // Remembers which background shell process (by id) this terminal pane
  // is currently connected to. Starts from whatever id was previously
  // saved for this tab, if this pane is being reopened.
  const termIdRef = useRef(tab.config?.terminalId || null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    // True once this effect's cleanup has run (e.g. the tab was switched
    // away from before we even finished setting up) — everything below
    // checks this before touching state, so a slow startup can't "wake up
    // late" and set up a terminal nobody wants anymore.
    let cancelled = false;
    // Filled in once setup finishes, so the cleanup function below can
    // reach the terminal/observer even though they're created inside an
    // async function (effect cleanup functions can't be async themselves).
    let cleanupInner = () => {};

    const setup = async () => {
      // Ask the background process what OS (and Windows build) we're
      // running on before creating the terminal — see the windowsPty
      // option below for why this matters.
      const platformInfo = await getPlatformInfo();
      if (cancelled) return;

      // Create the actual on-screen terminal widget with our color theme and
      // font, and attach it to our container <div>.
      const term = new Terminal({
        theme: THEME,
        fontFamily: '"Cascadia Code", ui-monospace, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        convertEol: true, // Treats line endings consistently across operating systems.
        allowTransparency: false,
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
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      // Lets us capture a faithful snapshot of this terminal's on-screen
      // contents when its pane goes away — see terminalSnapshots above.
      const serializeAddon = new SerializeAddon();
      term.loadAddon(serializeAddon);
      term.open(container);

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;

      // Fit after paint so the container has real dimensions.
      // In other words: right when the terminal is created, its container
      // might not have its final on-screen size yet, so we wait one frame
      // (requestAnimationFrame) before asking the terminal to resize itself
      // to fit — otherwise it might size itself to 0×0 and look broken. We
      // deliberately WAIT for this to finish (instead of firing it off and
      // moving on) before reattaching/starting the shell below — otherwise
      // the very first size we'd report to the background shell would be
      // xterm.js's default 80x24, not the real on-screen size, and a
      // reattached shell would keep wrapping its text for the wrong width
      // until the next resize happened to fix it.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (cancelled) return;
      fitAddon.fit();

      // Tells the background shell process how many rows/columns of text fit
      // on screen right now, so it can wrap output correctly (the same way a
      // real terminal window resizing affects how text wraps).
      const syncSize = (id) => {
        const { cols, rows } = term;
        if (cols && rows) window.terminals.resize(id, cols, rows);
      };

      // Re-attach to this tab's pty if it is still running (tab switch, pane
      // move, reload). After an app restart the pty is gone: restore the saved
      // scrollback, then start a fresh shell beneath it.
      //
      // In plain terms: when this terminal pane appears on screen, we first
      // check if it's reconnecting to an already-running shell (e.g. you
      // just switched tabs) — if so, we grab its live history and pick up
      // right where it left off. If the whole app was restarted since then,
      // the actual shell process is gone, so instead we print out whatever
      // history we managed to save from before, add a small divider message,
      // and start a brand new shell underneath it.
      const startTerminal = async () => {
        const savedId = tab.config?.terminalId;
        if (savedId) {
          const { alive, buffer } = await window.terminals.attach(savedId);
          if (alive) {
            // Prefer a proper in-memory snapshot from earlier in this same
            // app session (correctly reconstructs full-screen programs,
            // colors, cursor position, etc.) over the raw output log, which
            // can only be blindly replayed as flat text. See
            // terminalSnapshots above for why this distinction matters.
            const snapshot = terminalSnapshots.get(savedId);
            if (snapshot) {
              term.write(snapshot);
            } else if (buffer) {
              term.write(buffer);
            }
            termIdRef.current = savedId;
            syncSize(savedId);
            return;
          }
          if (buffer) {
            term.write(buffer);
            term.write('\r\n\x1b[2m── restored from previous session ──\x1b[0m\r\n\r\n');
          }
        }
        // No previous shell to reconnect to — start a fresh one in the
        // workspace's own folder, and remember its id on this tab so future
        // reopens can reconnect to it.
        const id = await window.terminals.create(workspace.workspace?.path);
        termIdRef.current = id;
        workspace.updateTab(tab.id, { config: { ...tab.config, terminalId: id } });
        syncSize(id);
      };

      startTerminal();

      // Whenever the background shell process prints something, and it's for
      // THIS terminal's id (not some other terminal tab), write it to the
      // on-screen display.
      const onData = window.terminals.onData((id, data) => {
        if (id === termIdRef.current) term.write(data);
      });

      // If the shell process this terminal is connected to exits (e.g. you
      // typed "exit"), show a message saying so.
      const onExit = window.terminals.onExit((id) => {
        if (id === termIdRef.current) {
          term.writeln('\r\n[Process exited]');
        }
      });

      // Whenever the user types something into the on-screen terminal, send
      // those exact keystrokes to the real background shell process.
      term.onData((data) => {
        if (termIdRef.current) window.terminals.write(termIdRef.current, data);
      });

      // Don't touch the terminal size while a drag is in flight — refitting on
      // every frame makes ConPTY rewrap the buffer continuously and the text
      // visibly churns. Let the pane clip during the drag, then do a single
      // fit + pty resize once the size has been stable for a moment.
      //
      // In plain terms: if you're dragging a divider to resize a split pane,
      // the terminal's size is changing dozens of times per second while you
      // drag. If we resized the actual shell process on every single one of
      // those tiny changes, the terminal's text would visibly jump around
      // and flicker. Instead, we wait until dragging has paused for 80
      // milliseconds before actually resizing anything, which feels
      // instant to the user but avoids that flicker.
      let fitTimer = null;
      const fitAndResize = () => {
        fitTimer = null;
        if (!fitAddonRef.current || !terminalRef.current) return;
        const dims = fitAddonRef.current.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        const { cols, rows } = terminalRef.current;
        // Skip the (somewhat expensive) resize entirely if the size hasn't
        // actually changed.
        if (dims.cols === cols && dims.rows === rows) return;
        fitAddonRef.current.fit();
        const term = terminalRef.current;
        if (termIdRef.current && term.cols && term.rows) {
          window.terminals.resize(termIdRef.current, term.cols, term.rows);
        }
      };

      // Watches the container's on-screen size for changes (e.g. resizing
      // the split pane or the whole window) and schedules a debounced fit.
      const resizeObserver = new ResizeObserver(() => {
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(fitAndResize, 80);
      });
      resizeObserver.observe(container);

      // Cleanup, run when this pane is closed/replaced or the tab changes:
      // stop watching for resizes, stop listening for terminal data/exit
      // events, and tear down the on-screen xterm.js widget. Note the actual
      // background shell process is intentionally NOT killed here.
      cleanupInner = () => {
        resizeObserver.disconnect();
        if (fitTimer) clearTimeout(fitTimer);
        onData();
        onExit();
        // The pty stays alive; it is killed when the tab is closed, not when
        // this component unmounts (tab switch / pane move). Since the shell
        // keeps running without an on-screen widget attached to it, save a
        // snapshot of exactly what this terminal looked like right now, so
        // reopening it later in this session can restore it faithfully
        // instead of falling back to replaying raw output (see
        // terminalSnapshots above).
        if (termIdRef.current) {
          try {
            terminalSnapshots.set(termIdRef.current, serializeAddon.serialize());
          } catch {
            // Best-effort only — if this fails for any reason, reattaching
            // will simply fall back to the raw-output replay path instead.
          }
        }
        term.dispose();
      };
    };

    setup();

    // If this effect is cleaned up before "setup" finishes (e.g. the tab
    // was switched away from almost immediately), mark it cancelled so the
    // still-in-flight setup bails out instead of creating a terminal nobody
    // will ever see, then run whatever real cleanup has been registered so
    // far.
    return () => {
      cancelled = true;
      cleanupInner();
    };
  }, [tab.id]);

  return (
    <div
      ref={containerRef}
      className="terminal-pane h-full w-full min-h-0 min-w-0 flex-1 overflow-hidden bg-app"
    />
  );
}
