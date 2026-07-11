import { describe, it, expect } from 'vitest';
import { pathForTerminalDrop, markdownLinkForDrop } from '../dragPaste';

describe('pathForTerminalDrop', () => {
  it('returns a plain path unchanged when it has no whitespace', () => {
    expect(pathForTerminalDrop('C:\\repo\\src\\main.js')).toBe('C:\\repo\\src\\main.js');
  });

  it('wraps a path containing spaces in double quotes', () => {
    expect(pathForTerminalDrop('C:\\Program Files\\app.exe')).toBe('"C:\\Program Files\\app.exe"');
  });
});

describe('markdownLinkForDrop', () => {
  it('builds a markdown link using the page title as the link text', () => {
    expect(markdownLinkForDrop({ url: 'https://example.com', title: 'Example Site' })).toBe(
      '[Example Site](https://example.com)'
    );
  });

  it('falls back to the url itself as the link text when there is no title', () => {
    expect(markdownLinkForDrop({ url: 'https://example.com', title: '' })).toBe(
      '[https://example.com](https://example.com)'
    );
  });
});
