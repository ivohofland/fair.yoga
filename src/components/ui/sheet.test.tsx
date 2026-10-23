import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Sheet } from './sheet';

// The browser queues a dialog's `close` event; it does not fire inside `close()`.
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(dismissible: boolean) {
  const onClose = vi.fn();
  const view = render(
    <StrictMode>
      <Sheet title="Refund" onClose={onClose} dismissible={dismissible}>
        body
      </Sheet>
    </StrictMode>,
  );
  const dialog = view.container.querySelector('dialog');
  if (dialog === null) throw new Error('no dialog');
  return { dialog, onClose, view };
}

const flush = () => act(() => vi.runAllTimers());

describe('Sheet under StrictMode', () => {
  it('stays open when the close queued by the remount arrives', () => {
    const { dialog, onClose } = mount(true);
    flush();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reopens a browser close while not dismissible', () => {
    const { dialog, onClose } = mount(false);
    flush();
    dialog.removeAttribute('open');
    act(() => {
      dialog.dispatchEvent(new Event('close'));
    });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports a browser close through onClose while dismissible', () => {
    const { dialog, onClose } = mount(true);
    flush();
    dialog.removeAttribute('open');
    act(() => {
      dialog.dispatchEvent(new Event('close'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not report its own close on unmount', () => {
    const { onClose, view } = mount(true);
    flush();
    view.unmount();
    flush();
    expect(onClose).not.toHaveBeenCalled();
  });
});
