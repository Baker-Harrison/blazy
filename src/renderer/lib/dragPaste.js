// Small, pure helper functions used by the "drag something from one pane
// into another" features (see design.html idea #5: drag-across-pane-type
// actions). Kept free of any DOM/Electron code so they're easy to test and
// easy to reason about on their own — the panes themselves just call these
// and use the plain string they get back.

// Turns a file path dropped onto a terminal into the exact text that should
// be sent to the shell. Most paths are fine to insert as-is, but if the path
// contains a space (or other whitespace), the shell would otherwise see it
// as several separate words — wrapping it in double quotes keeps it as one
// argument, the same way you'd type it by hand.
export function pathForTerminalDrop(path) {
  return /\s/.test(path) ? `"${path}"` : path;
}

// Turns a URL dragged out of the browser's address bar into a markdown link
// suitable for pasting into a text file — e.g. `[title](url)`. Falls back to
// using the url itself as the link text when no page title is available.
export function markdownLinkForDrop({ url, title }) {
  const text = title && title.trim() ? title.trim() : url;
  return `[${text}](${url})`;
}
