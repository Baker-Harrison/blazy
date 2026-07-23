import { describe, it, expect, vi } from 'vitest';
import { handleTerminalKeyEvent } from '../terminalClipboard';

// handleTerminalKeyEvent is the pure decision logic behind xterm's
// attachCustomKeyEventHandler: given a keyboard event and a small set of
// injected capabilities (read the current selection, copy text, read/paste
// the clipboard), it decides what to do and returns whether xterm should
// still process the key itself. Keeping this free of any real xterm/DOM
// object means we can test the actual policy directly.
function makeDeps(overrides = {}) {
  return {
    hasSelection: () => false,
    getSelection: () => '',
    copyText: vi.fn(),
    readClipboardText: vi.fn().mockResolvedValue(''),
    pasteText: vi.fn(),
    ...overrides,
  };
}

describe('handleTerminalKeyEvent', () => {
  it('copies the selection and blocks the keystroke when Ctrl+C is pressed with a selection', () => {
    const deps = makeDeps({ hasSelection: () => true, getSelection: () => 'hello world' });
    const result = handleTerminalKeyEvent(
      { type: 'keydown', ctrlKey: true, key: 'c' },
      deps
    );
    expect(deps.copyText).toHaveBeenCalledWith('hello world');
    expect(result).toBe(false);
  });

  it('does not copy and lets Ctrl+C through as SIGINT when there is no selection', () => {
    const deps = makeDeps({ hasSelection: () => false });
    const result = handleTerminalKeyEvent(
      { type: 'keydown', ctrlKey: true, key: 'c' },
      deps
    );
    expect(deps.copyText).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('blocks the keystroke on Ctrl+V so the native browser paste event can handle it without double pasting', () => {
    const deps = makeDeps({ readClipboardText: vi.fn().mockResolvedValue('pasted text') });
    const result = handleTerminalKeyEvent(
      { type: 'keydown', ctrlKey: true, key: 'v' },
      deps
    );
    expect(result).toBe(false);
    expect(deps.pasteText).not.toHaveBeenCalled();
  });

  it('ignores plain letter keys typed without Ctrl (e.g. typing "cat" in the shell)', () => {
    const deps = makeDeps({ hasSelection: () => true, getSelection: () => 'should not be used' });
    const result = handleTerminalKeyEvent({ type: 'keydown', ctrlKey: false, key: 'c' }, deps);
    expect(deps.copyText).not.toHaveBeenCalled();
    expect(deps.pasteText).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('ignores the matching keyup event so the action does not fire twice', () => {
    const deps = makeDeps({ hasSelection: () => true, getSelection: () => 'hello' });
    const result = handleTerminalKeyEvent({ type: 'keyup', ctrlKey: true, key: 'c' }, deps);
    expect(deps.copyText).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});
