import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const startRegistration = vi.hoisted(() => vi.fn());
vi.mock('@simplewebauthn/browser', () => ({ startRegistration }));

import { AddPasskey } from './add-passkey';

function domError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

describe('AddPasskey', () => {
  afterEach(() => {
    startRegistration.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function arrange() {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }),
    );
    return consoleError;
  }

  it('logs why when the ceremony fails, and tells the user', async () => {
    const consoleError = arrange();
    const boom = domError('SecurityError');
    startRegistration.mockRejectedValue(boom);
    render(<AddPasskey />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not add a passkey on this device.',
    );
    expect(consoleError).toHaveBeenCalledWith('[add-passkey] request failed', { err: boom });
  });

  it('does not log when the user dismisses the prompt', async () => {
    const consoleError = arrange();
    startRegistration.mockRejectedValue(domError('NotAllowedError'));
    render(<AddPasskey />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));

    await waitFor(() => expect(startRegistration).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add a passkey' })).toBeEnabled(),
    );
    expect(consoleError).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
