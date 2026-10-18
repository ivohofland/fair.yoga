import { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { Sheet } from './sheet';

afterEach(() => vi.restoreAllMocks());

describe('Sheet under StrictMode', () => {
  it('reopens a browser close while not dismissible', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const onClose = vi.fn();
    const { container } = render(
      <StrictMode>
        <Sheet title="Refund" onClose={onClose} dismissible={false}>
          body
        </Sheet>
      </StrictMode>,
    );
    const dialog = container.querySelector('dialog');
    if (dialog === null) throw new Error('no dialog');
    showModal.mockClear();

    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports a browser close through onClose while dismissible', () => {
    const onClose = vi.fn();
    const { container } = render(
      <StrictMode>
        <Sheet title="Refund" onClose={onClose}>
          body
        </Sheet>
      </StrictMode>,
    );
    const dialog = container.querySelector('dialog');
    if (dialog === null) throw new Error('no dialog');

    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
