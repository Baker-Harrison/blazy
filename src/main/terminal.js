// This file runs in the background "main" process and manages actual
// command-line terminals (like Command Prompt/PowerShell on Windows, or a
// Terminal.app-style shell on Mac/Linux) that live inside the app's
// Terminal panes. It uses a library called "node-pty" to spawn a real
// shell process and pipe its input/output back and forth to the on-screen
// terminal display.

const pty = require('node-pty');
const { app, ipcMain, BrowserWindow } = require('electron');
const os = require('os');
const db = require('./db');

// Which command-line program to launch depending on the operating system —
// PowerShell on Windows, zsh on Mac, bash on Linux.
const shells = {
  win32: 'powershell.exe',
  darwin: 'zsh',
  linux: 'bash',
};

// Scrollback kept per terminal so a renderer can re-attach (tab switch, pane
// move, window reload) without losing output. Persisted to the DB on quit so
// a restarted app can restore what was on screen.
//
// In plain terms: every terminal keeps a running log of everything it has
// printed (its "scrollback," just like scrolling up in a terminal window to
// see earlier output). We keep this text ourselves — capped at 200,000
// characters so it doesn't grow forever and eat memory — so that if you
// switch away from a terminal tab and come back, or even close and reopen
// the whole app, the terminal's previous output is still there waiting for
// you instead of showing a blank screen.
const BUFFER_CAP = 200_000;

// Trims a terminal's saved output down to at most `cap` characters, cutting
// from the front (the oldest output) once it grows past the cap.
//
// A naive "just cut at exactly `cap` characters" would sometimes slice
// straight through the middle of an ANSI escape sequence — the invisible
// codes a shell uses to set colors, move the cursor, etc. (they always
// start with the "ESC" character, \x1b). If we replay a buffer that starts
// mid-sequence, the leftover half of that broken code gets printed as
// visible garbage instead of being understood as a command — this is one
// of the ways terminal text can end up looking corrupted/garbled after
// reattaching to a terminal. To avoid that, once we know roughly where
// we're cutting, we look a little further forward for a safer spot to
// actually start from: ideally the beginning of the next escape sequence
// (so nothing is left dangling), or otherwise right after the next
// newline (so at least we're not mid-line). We only ever look a small
// distance ahead, so this never meaningfully changes how much history is
// kept.
function trimBufferSafely(text, cap) {
  if (text.length <= cap) return text;
  const rawCut = text.length - cap;
  const lookahead = text.slice(rawCut, rawCut + 256);
  const escIndex = lookahead.indexOf('\x1b');
  if (escIndex !== -1) return text.slice(rawCut + escIndex);
  const newlineIndex = lookahead.indexOf('\n');
  if (newlineIndex !== -1) return text.slice(rawCut + newlineIndex + 1);
  return text.slice(rawCut);
}

// Maps each terminal's unique id to its live process and buffered output.
const terminals = new Map(); // id -> { pty, buffer, unacked, paused }
let nextId = 1;

// ── Flow control (recommended by the xterm.js documentation) ──
//
// A shell can produce output far faster than the on-screen terminal can
// draw it (think of accidentally printing a huge file). The on-screen
// widget buffers what it can't draw yet, but that buffer has a hard limit
// — once overflowed, output is silently DROPPED, which shows up as
// missing/garbled text, and in the meantime the whole app lags.
//
// The fix is like a walkie-talkie protocol: we count how many characters
// we've sent to the screen that the screen hasn't yet confirmed drawing
// (each confirmation is an "ack" — short for acknowledgement). If too much
// is unconfirmed (HIGH_WATERMARK), we tell the shell process to pause its
// output; once the screen catches up (LOW_WATERMARK), we let it flow
// again. The shell doesn't lose anything while paused — its output just
// waits in the operating system's own pipe until we resume.
const HIGH_WATERMARK = 100_000;
const LOW_WATERMARK = 10_000;

// Called when the on-screen terminal confirms it has finished drawing
// `count` characters. If the shell was paused and the screen has now
// caught up enough, let its output flow again.
function ackTerminalData(id, count) {
  const entry = terminals.get(id);
  if (!entry) return;
  entry.unacked = Math.max(entry.unacked - count, 0);
  if (entry.paused && entry.unacked < LOW_WATERMARK) {
    entry.paused = false;
    entry.pty.resume();
  }
}

// Tells the renderer which OS it's running on, and (on Windows) which
// build of Windows — the on-screen terminal widget (xterm.js) needs this
// to correctly work around some Windows-specific quirks in how ConPTY
// (Windows' pty emulation layer) delivers output. In plain terms: ConPTY
// sometimes splits a line-ending (carriage-return + line-feed) across two
// separate chunks of output, and without knowing it's talking to ConPTY,
// xterm.js can misinterpret that split and draw garbled/duplicated lines.
// Passing this info lets xterm.js apply the correct workaround.
function getPlatformInfo() {
  const platform = process.platform;
  if (platform !== 'win32') return { platform };
  // os.release() on Windows looks like "10.0.26200" — the last number is
  // the actual build number, which is what xterm.js wants.
  const buildNumber = Number(os.release().split('.')[2]) || undefined;
  return { platform, windowsBuild: buildNumber };
}

// Sends a message to every open app window (there's usually just one, but
// this covers the case of multiple windows) — used to stream terminal
// output and exit notifications to whichever window(s) are displaying it.
function broadcast(channel, id, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, id, data);
  }
}

// Starts a brand-new terminal/shell process, running in the given starting
// folder ("cwd" = current working directory), or the user's home folder if
// none is given.
function createTerminal(cwd) {
  // Build a unique id combining the current time and a counter, so ids
  // never collide even if multiple terminals are created in the same
  // millisecond.
  const id = `term-${Date.now()}-${nextId++}`;
  const shell = shells[process.platform] || 'bash';
  const env = {
    ...process.env,
    TERM: 'xterm-256color', // Tells programs the terminal supports rich colors/formatting.
    COLORTERM: 'truecolor',
  };
  // Avoid double-forcing Electron/Chromium color modes into the shell session.
  delete env.FORCE_COLOR;

  // pty.spawn can throw SYNCHRONOUSLY — for example if the shell program
  // named above (powershell.exe/zsh/bash) isn't actually installed, or the
  // starting folder doesn't exist. Without this try/catch, that throw would
  // escape all the way up through the 'terminal:create' handler below,
  // which Electron turns into a rejected promise on the renderer side — but
  // wrapping it here lets us turn it into a clear, specific error message
  // (rather than whatever raw, technical message node-pty happens to
  // throw), so the on-screen terminal pane can show something a user can
  // actually understand instead of hanging forever with no explanation.
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || os.homedir(),
      env,
      // ConPTY reflows the buffer on resize; winpty repaints it garbled.
      // (ConPTY and winpty are two different ways Windows can emulate a
      // proper terminal for a program like PowerShell; ConPTY is the newer,
      // more correct one, so we always ask for it.)
      useConpty: true,
    });
  } catch (err) {
    throw new Error(`Couldn't start "${shell}": ${err.message}`);
  }

  const entry = { pty: ptyProcess, buffer: '', unacked: 0, paused: false };

  // Every time the shell process prints something, append it to our saved
  // buffer (trimming from the front if it grows past BUFFER_CAP) and
  // immediately forward it to the screen so it appears live, character by
  // character, just like typing directly into a real terminal window.
  // We also count each chunk as "not yet confirmed drawn" and pause the
  // shell if too much output is in flight — see flow control notes above.
  ptyProcess.onData((data) => {
    entry.buffer = trimBufferSafely(entry.buffer + data, BUFFER_CAP);
    entry.unacked += data.length;
    if (!entry.paused && entry.unacked > HIGH_WATERMARK) {
      entry.paused = true;
      ptyProcess.pause();
    }
    broadcast('terminal:data', id, data);
  });
  // When the shell process ends (e.g. you type "exit"), let the UI know so
  // it can show that the terminal has closed, and stop tracking it.
  ptyProcess.onExit(({ exitCode }) => {
    broadcast('terminal:exit', id, exitCode);
    terminals.delete(id);
  });

  terminals.set(id, entry);
  return id;
}

// Re-attach to a terminal by id. If the pty is still alive, return its live
// scrollback; if the app was restarted, return the scrollback persisted at
// quit so the renderer can restore it above a fresh shell.
//
// In plain terms: when a terminal tab is opened/reopened on screen, this is
// how it "catches up" on everything the terminal already printed before —
// either from the still-running process's memory, or (if the whole app was
// closed and reopened) from what we saved to the database last time.
async function attachTerminal(id) {
  const entry = terminals.get(id);
  if (entry) {
    // A re-attach means the on-screen side is starting over (e.g. the
    // window was reloaded), so any "not yet confirmed drawn" count from
    // the old screen is meaningless now — reset it and make sure the
    // shell isn't left permanently paused waiting for confirmations that
    // will never come.
    entry.unacked = 0;
    if (entry.paused) {
      entry.paused = false;
      entry.pty.resume();
    }
    return { alive: true, buffer: entry.buffer };
  }
  const saved = await db.getTerminalBuffer(id);
  return { alive: false, buffer: saved || '' };
}

// Sends keystrokes/typed text from the UI into the actual shell process, as
// if you'd typed them directly into a terminal window.
function writeTerminal(id, data) {
  terminals.get(id)?.pty.write(data);
}

// Tells the shell process the terminal's on-screen size changed (in
// character columns and rows), so text wrapping and full-screen programs
// (like a text editor running inside the terminal) redraw correctly.
function resizeTerminal(id, cols, rows) {
  terminals.get(id)?.pty.resize(cols, rows);
}

// Fully shuts down a terminal: kills the running shell process and removes
// any saved scrollback for it, since the user explicitly closed this
// terminal for good (as opposed to just switching away from its tab).
async function killTerminal(id) {
  const entry = terminals.get(id);
  if (entry) {
    // The shell process could have already died on its own between the
    // renderer deciding to close this tab and this handler actually
    // running (e.g. the user typed "exit" right as they clicked "close
    // tab"). Killing an already-dead process can throw — that's fine, it
    // just means our job here is already done, so we swallow the error
    // instead of letting it escape and abort the rest of this cleanup
    // (deleting the tab's saved scrollback, below).
    try {
      entry.pty.kill();
    } catch {
      // Already exited — nothing left to kill.
    }
    terminals.delete(id);
  }
  await db.deleteTerminalBuffer(id);
}

// Saves every still-running terminal's current scrollback text to the
// database, so it can be restored the next time the app starts. This is
// called right before the app fully quits.
function persistBuffers() {
  db.saveTerminalBuffersSync([...terminals].map(([id, entry]) => [id, entry.buffer]));
}

// Wires up all of the functions above so the on-screen UI can call them
// through the app's controlled messaging channel (see preload.js), and
// makes sure we save terminal output before the app closes.
function registerTerminalHandlers() {
  ipcMain.handle('terminal:platformInfo', () => getPlatformInfo());
  ipcMain.handle('terminal:create', (_e, cwd) => createTerminal(cwd));
  ipcMain.handle('terminal:attach', (_e, id) => attachTerminal(id));
  ipcMain.handle('terminal:write', (_e, id, data) => writeTerminal(id, data));
  ipcMain.handle('terminal:resize', (_e, id, cols, rows) => resizeTerminal(id, cols, rows));
  ipcMain.handle('terminal:kill', (_e, id) => killTerminal(id));
  // Confirmations from the screen that output has been drawn — these use a
  // fire-and-forget message (ipcMain.on, not handle) since they're sent
  // very frequently and need no reply. See flow control notes above.
  ipcMain.on('terminal:ack', (_e, id, count) => ackTerminalData(id, count));

  app.on('before-quit', () => {
    persistBuffers();
  });
}

module.exports = { registerTerminalHandlers };
