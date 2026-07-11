// Unit tests for the terminal file-path link helper.
//
// These pin down two things that have already bitten us once:
//   1. The regex really does match the kinds of paths CLI tools print
//      (relative "demo/index.html", Windows drive paths, file:// URIs, …)
//      and really does NOT match ordinary prose like "either/or".
//   2. resolveFilePath correctly turns a match into a real filesystem path
//      (especially the Windows-flavored "file:///C:/..." form Claude Code
//      emits as an OSC 8 hyperlink target).
//
// The deeper bug that made file links do nothing was NOT the regex — it was
// WebLinksAddon silently discarding every non-URL match. That behavior is
// documented in filePathLinks.js; these tests keep the replacement path
// logic honest so a future change can't re-break the matching half.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FILE_PATH_REGEX,
  unquote,
  resolveFilePath,
  computeFilePathLinks,
  openFileLink,
} from '../filePathLinks';

// Runs the path regex against a whole line and returns every match (the
// provider always adds the global flag itself, so we do the same here).
function matchAll(line) {
  const rex = new RegExp(FILE_PATH_REGEX.source, `${FILE_PATH_REGEX.flags || ''}g`);
  return [...line.matchAll(rex)].map((m) => m[0]);
}

describe('FILE_PATH_REGEX', () => {
  it('matches relative project-style paths with a file extension', () => {
    expect(matchAll('Updated demo/index.html successfully')).toEqual(['demo/index.html']);
    expect(matchAll('error in src\\main\\files.js:12:5')).toEqual(['src\\main\\files.js:12:5']);
    expect(matchAll('see src/renderer/lib/filePathLinks.js')).toEqual([
      'src/renderer/lib/filePathLinks.js',
    ]);
  });

  it('matches Windows drive paths and file:// URIs', () => {
    expect(matchAll('open C:\\Users\\you\\notes.txt please')).toEqual([
      'C:\\Users\\you\\notes.txt',
    ]);
    expect(matchAll('open C:/Users/you/notes.txt please')).toEqual(['C:/Users/you/notes.txt']);
    expect(matchAll('see file:///C:/Users/you/notes.txt end')).toEqual([
      'file:///C:/Users/you/notes.txt',
    ]);
  });

  it('matches quoted paths and home-relative paths', () => {
    expect(matchAll('open "~/project/notes.txt" now')).toEqual(['"~/project/notes.txt"']);
    expect(matchAll('open ~/project/notes.txt now')).toEqual(['~/project/notes.txt']);
  });

  it('does not treat ordinary prose or URL tails as file paths', () => {
    expect(matchAll('either/or is a common phrase')).toEqual([]);
    // Bare filename with no folder piece — too ambiguous, intentionally skipped.
    expect(matchAll('see notes.txt later')).toEqual([]);
    // The https URL itself is handled by WebLinksAddon, not this regex.
    // Our POSIX look-behind should not also light up the "/a/b.html" tail.
    expect(matchAll('visit https://example.com/a/b.html today')).toEqual([]);
  });
});

describe('unquote', () => {
  it('strips matching surrounding quotes and leaves bare text alone', () => {
    expect(unquote('"C:\\a\\b.txt"')).toBe('C:\\a\\b.txt');
    expect(unquote("'~/x'")).toBe('~/x');
    expect(unquote('demo/index.html')).toBe('demo/index.html');
  });
});

describe('resolveFilePath', () => {
  beforeEach(() => {
    // resolveFilePath asks the background process for the home folder when
    // expanding "~/...". Stub that out so the test doesn't need a real
    // Electron preload bridge.
    globalThis.window = {
      fs: {
        homeDir: vi.fn(async () => 'C:\\Users\\tester'),
      },
    };
  });

  it('converts Windows file:// URIs into plain drive paths', async () => {
    await expect(resolveFilePath('file:///C:/Users/you/notes.txt')).resolves.toBe(
      'C:/Users/you/notes.txt'
    );
    // Authority form some tools emit: file://hostname/C:/...
    await expect(resolveFilePath('file://MY-PC/C:/Users/you/notes.txt')).resolves.toBe(
      'C:/Users/you/notes.txt'
    );
  });

  it('expands a leading ~ to the user home folder', async () => {
    await expect(resolveFilePath('~/project/notes.txt')).resolves.toBe(
      'C:\\Users\\tester/project/notes.txt'
    );
  });

  it('unwraps quotes before resolving', async () => {
    await expect(resolveFilePath('"file:///C:/Users/you/a b.txt"')).resolves.toBe(
      'C:/Users/you/a b.txt'
    );
  });

  it('leaves relative and absolute plain paths alone (after unquoting)', async () => {
    await expect(resolveFilePath('demo/index.html')).resolves.toBe('demo/index.html');
    await expect(resolveFilePath('C:\\Users\\you\\notes.txt')).resolves.toBe(
      'C:\\Users\\you\\notes.txt'
    );
  });
});

// ── computeFilePathLinks with a tiny fake terminal buffer ──
//
// We don't spin up a real xterm.js Terminal here (that wants a DOM). Instead
// we feed computeFilePathLinks a minimal stub that looks enough like
// terminal.buffer.active for the scanning/mapping helpers to walk cells.

function makeFakeTerminal(lineText) {
  // One cell per character, width 1 — good enough for ASCII path text.
  const cells = [...lineText].map((ch) => ({
    getChars: () => ch,
    getWidth: () => 1,
  }));
  const nullCell = {
    chars: '',
    width: 1,
    getChars() {
      return this.chars;
    },
    getWidth() {
      return this.width;
    },
  };
  const line = {
    length: cells.length,
    isWrapped: false,
    translateToString: () => lineText,
    getCell(i, cell) {
      const src = cells[i] || { getChars: () => '', getWidth: () => 0 };
      cell.chars = src.getChars();
      cell.width = src.getWidth();
      // getChars/getWidth on the shared nullCell read from these fields
      // after getCell copies into it.
    },
  };
  // Make getCell actually populate the cell object's methods the way the
  // real buffer does: the mapper reuses one cell object and calls
  // getChars/getWidth on it after each getCell.
  line.getCell = (i, cell) => {
    const src = cells[i];
    if (!src) {
      cell.getChars = () => '';
      cell.getWidth = () => 0;
      return;
    }
    cell.getChars = () => src.getChars();
    cell.getWidth = () => src.getWidth();
  };

  return {
    buffer: {
      active: {
        getLine: (idx) => (idx === 0 ? line : undefined),
        getNullCell: () => nullCell,
      },
    },
  };
}

describe('computeFilePathLinks', () => {
  it('returns a link range for a relative path and does NOT require it to be a URL', () => {
    // This is the regression test for the WebLinksAddon isUrl filter: a
    // plain "demo/index.html" must produce a clickable link, even though
    // `new URL("demo/index.html")` would throw.
    const term = makeFakeTerminal('Updated demo/index.html successfully');
    const activate = vi.fn();
    const links = computeFilePathLinks(1, term, activate);

    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('demo/index.html');
    // 1-based columns: "Updated " is 8 chars, so the path starts at col 9.
    expect(links[0].range.start).toEqual({ x: 9, y: 1 });
    expect(links[0].range.end.y).toBe(1);
    expect(links[0].range.end.x).toBe(9 + 'demo/index.html'.length - 1);

    // Clicking should call our activate with the matched text.
    links[0].activate({}, 'demo/index.html');
    expect(activate).toHaveBeenCalledWith({}, 'demo/index.html');
  });

  it('returns no links for prose without a path', () => {
    const term = makeFakeTerminal('either/or is fine');
    expect(computeFilePathLinks(1, term, vi.fn())).toEqual([]);
  });
});

describe('openFileLink', () => {
  it('resolves a relative path against session.cwd and opens it in the pane', async () => {
    // layoutTree.findPaneWithTab walks a real layout tree, so give it a
    // minimal one-pane layout that actually contains our tab.
    const openFileInPane = vi.fn();
    const session = {
      tabId: 'tab-1',
      cwd: 'C:\\Users\\tester\\project',
      workspace: {
        // Real layout nodes use `tabIds` (string ids), not a full tabs array.
        layout: {
          type: 'pane',
          id: 'pane-1',
          tabIds: ['tab-1'],
          activeTabId: 'tab-1',
        },
        openFileInPane,
      },
    };

    globalThis.window = {
      fs: {
        homeDir: vi.fn(async () => 'C:\\Users\\tester'),
        exists: vi.fn(async (p) => p === 'C:\\Users\\tester\\project\\demo\\index.html'
          || p === 'C:\\Users\\tester\\project\\demo/index.html'),
      },
    };

    await openFileLink(session, 'demo/index.html');

    expect(window.fs.exists).toHaveBeenCalled();
    expect(openFileInPane).toHaveBeenCalledTimes(1);
    const [paneId, filePath] = openFileInPane.mock.calls[0];
    expect(paneId).toBe('pane-1');
    // Joined with the Windows-style separator from cwd.
    expect(filePath.replace(/\//g, '\\')).toBe(
      'C:\\Users\\tester\\project\\demo\\index.html'
    );
  });

  it('silently does nothing when the path does not exist on disk', async () => {
    const openFileInPane = vi.fn();
    const session = {
      tabId: 'tab-1',
      cwd: 'C:\\Users\\tester\\project',
      workspace: {
        layout: {
          type: 'pane',
          id: 'pane-1',
          tabIds: ['tab-1'],
          activeTabId: 'tab-1',
        },
        openFileInPane,
      },
    };
    globalThis.window = {
      fs: {
        homeDir: vi.fn(async () => 'C:\\Users\\tester'),
        exists: vi.fn(async () => false),
      },
    };

    await openFileLink(session, 'no/such/file.txt');
    expect(openFileInPane).not.toHaveBeenCalled();
  });
});
