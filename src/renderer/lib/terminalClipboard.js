// The decision logic behind copy/paste inside a terminal pane.
//
// Real terminals can't just use plain Ctrl+C/Ctrl+V the way a text editor
// does, because Ctrl+C already means something important to a shell: it
// sends an interrupt signal (SIGINT) to stop whatever's currently running.
// So this app uses "smart" Ctrl+C: if you have text selected, Ctrl+C copies
// it (like everywhere else); if you don't have anything selected, Ctrl+C
// falls through and works exactly like it always has (interrupting the
// running program). Ctrl+V always pastes.
//
// When pasting with Ctrl+V, the text is handed to a paste callback (pasteText).
// In TerminalPane, this calls xterm's term.paste(text) rather than writing
// raw text straight to the shell process stdin. That distinction is crucial:
// interactive command-line apps (like agy / Antigravity CLI) enable "bracketed
// paste mode". When bracketed paste mode is active, xterm wraps pasted text
// in special brackets (\x1b[200~ ... \x1b[201~) so the CLI knows the text was
// pasted all at once. This allows agy to display multiline pastes as neat
// "[Pasted Text #1 +100 lines]" blocks instead of overflowing the input line
// by line.
//
// This function is deliberately kept free of any real xterm.js or Electron
// objects — it's handed small stand-in functions ("dependencies") for the
// few things it needs to do (read the selection, copy text, read/paste the
// clipboard), so the actual policy can be tested on its own, and the
// TerminalPane component just wires the real implementations in.
//
// It's meant to be plugged straight into xterm's
// attachCustomKeyEventHandler(event => boolean): return true to let xterm
// keep handling the key as normal (nothing to do with us), or false to tell
// xterm "we've already handled this one, don't do anything with it."
export function handleTerminalKeyEvent(event, deps) {
  const { hasSelection, getSelection, copyText, readClipboardText, pasteText } = deps;

  // Only act on Ctrl-held keydowns. xterm calls this handler for every key
  // event (including keyups, and plain letters typed with no modifier), so
  // without this guard, typing an ordinary "c" or "v" while running a shell
  // command (e.g. "cat", "vim") would be wrongly treated as copy/paste.
  if (event.type !== 'keydown' || !event.ctrlKey) return true;

  if (event.key.toLowerCase() === 'v') {
    // Return false to stop xterm from handling Ctrl+V as a typed character
    // (which would send ASCII \x16 to the shell).
    // In Electron and browser environments, Ctrl+V automatically triggers the
    // browser's native 'paste' DOM event on xterm's hidden helper textarea element.
    // TerminalPane intercepts that paste event and sends bracketed-paste-formatted
    // text to the shell (see formatPasteForTerminal) so TUIs like agy can show
    // "[Pasted text #N +N lines]" chips.
    // We do NOT call pasteText() here during keydown, because doing so would paste
    // the text twice (once manually here and once via the native paste event).
    return false;
  }

  if (hasSelection()) {
    copyText(getSelection());
    return false;
  }

  return true;
}
