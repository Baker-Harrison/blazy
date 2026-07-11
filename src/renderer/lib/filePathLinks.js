// ── Clickable file paths in terminal output ──
//
// This file teaches Blazy's on-screen terminal how to turn printed file paths
// (things like "demo/index.html", "C:\Users\you\notes.txt", or a
// "file:///C:/..." URI) into real clickable links that open in the in-app
// editor.
//
// WHY THIS EXISTS INSTEAD OF JUST USING THE "WebLinksAddon"
// ─────────────────────────────────────────────────────────
// The terminal library (xterm.js) ships a helper called WebLinksAddon that
// underlines clickable text. We already use it for normal web URLs
// (https://...). It also lets you hand it a custom regex for other kinds of
// text — which is exactly what we want for file paths.
//
// There's a catch, though: after the regex finds a match, WebLinksAddon runs
// an internal "is this a real URL?" check (it tries `new URL(match)`). That
// check is perfect for web addresses, but it REJECTS every ordinary file
// path, because "demo/index.html" and "C:\Users\..." are not valid URLs.
// Only things like "file:///C:/..." or "https://..." survive. So every
// carefully-written path regex we passed in was matching the text, then
// silently throwing the match away — which is why file names printed by
// Claude Code and compilers looked blue/colored but did nothing when
// clicked.
//
// The fix is this small, purpose-built link provider: same idea as
// WebLinksAddon (scan a line, find path-shaped text, underline it, call a
// handler on click), but WITHOUT that URL-only filter. Web URLs keep using
// the real WebLinksAddon; file paths use this instead.

import { findPaneWithTab } from './layoutTree';

// Characters that never appear anywhere in an unquoted path match — these
// reliably mean "the path ended here."
const NEVER = '\\s"\'<>|';
// Characters ALSO disallowed as the very last character of an unquoted match
// (see unquotedPattern below for why).
const TRAILING_PUNCTUATION = ',.;:!?()\\[\\]{}';

// The "unquoted" version of a pattern for a given path prefix: the prefix
// itself, then as much non-delimiter text as possible — but requiring the
// very last character to also not be trailing punctuation. Without that
// last restriction, text like "see (C:\notes.txt)" would swallow the
// closing ")" into the match, producing a path that doesn't actually exist
// and so silently failing to open when clicked (quotes don't have this
// problem — the closing quote itself unambiguously marks where the path
// ends, which is what quotedPattern below relies on instead).
function unquotedPattern(prefixSource) {
  return `${prefixSource}[^${NEVER}]*[^${NEVER}${TRAILING_PUNCTUATION}]`;
}

// The "quoted" version of a pattern for a given path prefix: the prefix
// wrapped in a matching pair of quote characters.
function quotedPattern(prefixSource, quoteChar) {
  return `${quoteChar}${prefixSource}[^${quoteChar}\\r\\n]+${quoteChar}`;
}

// Every kind of path "start" this recognizes, besides the POSIX-style
// leading "/" (handled separately below, since — unlike these — it needs an
// extra check to avoid colliding with the URL-matching addon). Each one
// starts with "(?<!...)" to make sure it's not actually the tail end of a
// longer word — without that, the "s:" inside "http**s:**//" would
// otherwise be misread as Windows drive letter "s", and similarly for the
// others.
const PREFIXES = [
  '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]', // C:\ or C:/ — a Windows drive letter
  '\\\\\\\\', // \\server\share — a Windows network/UNC path
  '(?<![A-Za-z0-9~])~[\\\\/]', // ~/ or ~\ — relative to the user's home folder
  '(?<![A-Za-z0-9])file://', // file:///C:/... or file:///home/... — a "file" URI
];

// NOTE: no 'g' flag here — the link provider always appends its own 'g' flag
// when scanning a line (`new RegExp(source, flags + "g")`), so including one
// here would produce the invalid flag string "gg" and throw.
export const FILE_PATH_REGEX = new RegExp(
  [
    ...PREFIXES.map((p) => quotedPattern(p, '"')),
    ...PREFIXES.map((p) => quotedPattern(p, "'")),
    ...PREFIXES.map(unquotedPattern),
    quotedPattern('/', '"'),
    quotedPattern('/', "'"),
    // POSIX-style absolute path ("/foo/bar"): the "(?<![\\w:/])" look-behind
    // stops this from matching a mere TAIL of something bigger — the
    // "//foo/bar" part of a "https://foo/bar" URL, the "/a/b.html" part of
    // "example.com/a/b.html", or the "/07/11" part of a date like
    // "2026/07/11" — and requiring 2+ segments (the "(?:.../)+" ) avoids
    // treating a bare "/x" as a path.
    `(?<![\\w:/])/(?:[^${NEVER}]+/)+[^${NEVER}]*[^${NEVER}${TRAILING_PUNCTUATION}]`,
    // RELATIVE path with an obvious file name at the end — what tools like
    // Claude Code and compilers print (e.g. "demo/index.html" or
    // "src\\main\\files.js:12"). To keep ordinary prose like "either/or"
    // from lighting up as a link, this is much stricter than the absolute
    // patterns above: every folder piece is plain word characters (plus
    // dots/dashes), the last piece MUST end in a dot-extension (".html",
    // ".js", ...), and it can't be the tail of a bigger path or URL (the
    // "(?<!...)" look-behind). It may optionally end in ":line" or
    // ":line:column" numbers, which openFileLink below knows to snip off.
    // Clicking is still safe either way — openFileLink double-checks the
    // file really exists before doing anything at all.
    '(?<![\\w.:~/\\\\-])(?:[\\w.-]+[\\\\/])+[\\w.-]+\\.[A-Za-z0-9]+(?::\\d+(?::\\d+)?)?',
  ].join('|')
);

// Strips a leading/trailing matching quote character, if the matched text
// was wrapped in one (see the quoted alternatives in FILE_PATH_REGEX above).
export function unquote(text) {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return text.slice(1, -1);
    }
  }
  return text;
}

// The current user's home folder path (e.g. "C:\Users\you"), fetched from
// the background process once and cached — it can't change while the app
// is running, so every terminal pane after the first reuses this same
// answer instead of asking again. Used to expand a "~/..." link (as CLI
// tools commonly print to mean "relative to your home folder") into a
// real, checkable path.
let homeDirPromise = null;
function getHomeDir() {
  if (!homeDirPromise) homeDirPromise = window.fs.homeDir();
  return homeDirPromise;
}

// Turns whatever FILE_PATH_REGEX matched into a real filesystem path that
// window.fs.exists/readFile can actually use: unwraps quotes, converts a
// "file://" URI (e.g. "file:///C:/Users/you/notes.txt" — the form several
// CLI tools, including Claude Code, print for a file) into a plain path,
// and expands a leading "~" into the user's real home folder.
export async function resolveFilePath(rawText) {
  let text = unquote(rawText.trim());

  if (/^file:\/\//i.test(text)) {
    let rest = text.slice('file://'.length);
    // Some tools put the computer's name between the slashes (e.g.
    // "file://MY-PC/C:/Users/...") — that "authority" part isn't part of
    // the actual path on disk, so drop it, keeping everything from the
    // next "/" onward.
    if (rest && rest[0] !== '/') {
      const slash = rest.indexOf('/');
      rest = slash === -1 ? rest : rest.slice(slash);
    }
    // "file:///C:/Users/..." has an extra leading slash before the drive
    // letter (the empty "authority" part of the URI) — strip it, since
    // "/C:/Users/..." isn't a real Windows path but "C:/Users/..." is.
    if (/^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1);
    try {
      // URIs can percent-encode characters like spaces ("%20") — decode
      // them back to the real characters the file system actually uses.
      rest = decodeURIComponent(rest);
    } catch {
      // Malformed percent-encoding — fall back to using it as-is rather
      // than failing outright.
    }
    return rest;
  }

  if (/^~[\\/]/.test(text)) {
    const home = await getHomeDir();
    // Replace just the "~" with the home folder, keeping whichever slash
    // followed it (e.g. "~/foo" → "C:\Users\you" + "/foo").
    return home + text.slice(1);
  }

  return text;
}

// Called when a file-path link is clicked in a terminal. Since plain printed
// text can never be 100% certain to be a real, existing file (unlike a URL,
// which is just a URL), this double-checks with the background process that
// something really exists at that path before doing anything — clicking text
// that merely LOOKS like a path (but isn't a real file) silently does
// nothing, rather than opening a blank/broken editor tab.
//
// `session` is the live terminal session object from TerminalPane (it knows
// which tab/workspace this terminal belongs to, and which folder the shell
// was started in — needed for relative paths like "demo/index.html").
export async function openFileLink(session, rawText) {
  let filePath = await resolveFilePath(rawText);

  // A path that doesn't start from a drive letter ("C:\..."), a slash, or a
  // network prefix ("\\server\...") is RELATIVE — it only means something
  // "from" a particular folder. Tools like Claude Code print paths relative
  // to the folder the terminal started in (e.g. "demo/index.html"), so
  // that's the folder we glue onto the front to get a full, real path.
  //
  // We join with BOTH separators normalized to the platform's own one by
  // using a simple string join here (the renderer has no Node `path` module).
  // Windows is fine with mixed "C:\folder\demo/index.html" style paths for
  // existence checks; the important part is the folder prefix is present.
  const isAbsolute = /^([A-Za-z]:[\\/]|[\\/])/.test(filePath);
  if (!isAbsolute) {
    if (!session.cwd) return;
    // Prefer backslash on Windows-looking cwd, forward slash otherwise, so
    // the joined path looks natural. Either form still works for exists().
    const sep = /\\/.test(session.cwd) ? '\\' : '/';
    // Strip any leading "./" the tool may have printed — joining
    // "C:\proj" + "\./demo/x" would produce a nonsense path.
    const relative = filePath.replace(/^\.[\\/]/, '');
    filePath = `${session.cwd}${sep}${relative}`;
  }

  let exists = await window.fs.exists(filePath);
  if (!exists) {
    // Tools often tack a line (and sometimes column) number onto the end,
    // like "src\main\files.js:12:5" — no file literally has that name, so
    // when the path as printed doesn't exist, try again with that numeric
    // tail snipped off before giving up.
    const withoutLineNumbers = filePath.replace(/(:\d+)+$/, '');
    if (withoutLineNumbers !== filePath && (await window.fs.exists(withoutLineNumbers))) {
      filePath = withoutLineNumbers;
      exists = true;
    }
  }
  if (!exists) return;
  const workspace = session.workspace;
  if (!workspace?.layout) return;
  const paneId = findPaneWithTab(workspace.layout, session.tabId)?.id;
  if (!paneId) return;
  workspace.openFileInPane(paneId, filePath);
}

// ── Turning regex matches into clickable terminal ranges ──
//
// xterm.js asks every registered "link provider" "are there any links on
// line Y?" and expects back a list of ranges (start column, end column) plus
// a click handler. The helpers below do the fiddly part of that: scan the
// line's text with FILE_PATH_REGEX, then map each match's character offset
// back to the terminal's cell coordinates (which is not always 1:1 —
// emoji and wide Asian characters take two columns).
//
// This is adapted from @xterm/addon-web-links' LinkComputer, minus the
// "must be a valid URL" filter that broke file paths (see the top-of-file
// comment).

// Walks a line (and, if the line is a soft-wrap continuation of a long
// previous line, a little of the surrounding wrapped content) and returns
// the combined string plus which buffer line the combined string starts on.
// Stops expanding at whitespace or a hard length cap so we don't scan the
// entire scrollback for every hover.
function getWindowedLineStrings(lineIndex, terminal) {
  let topIdx = lineIndex;
  let bottomIdx = lineIndex;
  let length = 0;
  let content = '';
  const lines = [];

  const active = terminal.buffer.active;
  let line = active.getLine(lineIndex);
  if (!line) return [lines, topIdx];

  const currentContent = line.translateToString(true);

  // Expand upward through soft-wrapped lines that don't start with a space
  // (those are continuations of one long logical line).
  if (line.isWrapped && currentContent[0] !== ' ') {
    length = 0;
    while ((line = active.getLine(--topIdx)) && length < 2048) {
      content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (!line.isWrapped || content.indexOf(' ') !== -1) break;
    }
    lines.reverse();
  }

  lines.push(currentContent);

  // Expand downward through further soft-wrapped continuations.
  length = 0;
  while ((line = active.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
    content = line.translateToString(true);
    length += content.length;
    lines.push(content);
    if (content.indexOf(' ') !== -1) break;
  }

  return [lines, topIdx];
}

// Maps a character offset inside the windowed string back to a buffer
// [lineIndex, columnIndex] pair (0-based). Handles wide characters so the
// underline lands on the right cells.
function mapStrIdx(terminal, lineIndex, rowIndex, stringIndex) {
  const buf = terminal.buffer.active;
  const cell = buf.getNullCell();
  let start = rowIndex;
  while (stringIndex) {
    const line = buf.getLine(lineIndex);
    if (!line) return [-1, -1];
    for (let i = start; i < line.length; ++i) {
      line.getCell(i, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width) {
        stringIndex -= chars.length || 1;
        // Correct for early-wrapped wide chars at the end of a line (same
        // edge case the upstream WebLinksAddon accounts for).
        if (i === line.length - 1 && chars === '') {
          const next = buf.getLine(lineIndex + 1);
          if (next && next.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) stringIndex += 1;
          }
        }
      }
      if (stringIndex < 0) return [lineIndex, i];
    }
    lineIndex++;
    start = 0;
  }
  return [lineIndex, start];
}

// Scans the terminal buffer around line `y` (1-based, as xterm uses) for
// file-path-shaped text and returns link descriptors ready for xterm's
// linkifier. `activate` is called with (mouseEvent, matchedText) on click.
export function computeFilePathLinks(y, terminal, activate, regex = FILE_PATH_REGEX) {
  const rex = new RegExp(regex.source, `${regex.flags || ''}g`);
  const [lineStrings, startLineIndex] = getWindowedLineStrings(y - 1, terminal);
  const combined = lineStrings.join('');
  const result = [];
  let match;

  while ((match = rex.exec(combined))) {
    const text = match[0];
    // NOTE: deliberately NO "is this a URL?" filter here — see the big
    // comment at the top of this file. That filter is why WebLinksAddon
    // alone could never make file paths clickable.

    const [startY, startX] = mapStrIdx(terminal, startLineIndex, 0, match.index);
    const [endY, endX] = mapStrIdx(terminal, startY, startX, text.length);
    if (startY === -1 || startX === -1 || endY === -1 || endX === -1) continue;

    // xterm ranges are 1-based, and end.x is inclusive of the last cell.
    result.push({
      text,
      range: {
        start: { x: startX + 1, y: startY + 1 },
        end: { x: endX, y: endY + 1 },
      },
      activate,
    });
  }

  return result;
}

// Builds an xterm.js ILinkProvider that underlines file paths and opens
// them via openFileLink when clicked. `getSession` is a tiny function that
// returns the current terminal session object (so the click handler always
// sees the latest workspace/cwd, not a stale snapshot from create-time).
export function createFilePathLinkProvider(getSession) {
  return {
    provideLinks(y, callback) {
      const session = getSession();
      if (!session) {
        callback(undefined);
        return;
      }
      const links = computeFilePathLinks(y, session.term, (_event, text) => {
        openFileLink(session, text);
      });
      callback(links);
    },
  };
}
