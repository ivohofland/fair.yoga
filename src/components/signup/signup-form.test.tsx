import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SignupForm } from './signup-form';

const PROPS = {
  title: 'Start teaching on fair.yoga',
  intro: 'One email address, no password.',
  sentMessage: 'We sent you a link.',
};

function submit(email = 'anna@example.com') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: /Send me the link/i }));
}

describe('SignupForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('swaps itself for the sent-message panel on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<SignupForm {...PROPS} />);

    submit();

    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(screen.getByText(PROPS.sentMessage)).toBeInTheDocument();
  });

  it('sends the typed email as the request body', async () => {
    const mock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mock);
    render(<SignupForm {...PROPS} />);

    submit('teacher@example.com');

    await screen.findByText('Check your inbox');
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/teacher-signup');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'teacher@example.com' });
  });

  /**
   * The regression this pins: `handleSubmit` used to call `res.ok ? 'sent' :
   * 'error'` and discard the response body entirely, so a 429 rate-limit
   * refusal and a 400 validation failure both rendered the same static
   * "Something went wrong" — telling the teacher nothing about why, or how
   * long to wait.
   */
  it('shows the server-provided message on a non-ok response, not a generic one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: 'Too many signup attempts. Try again in 12 minutes.' } }),
      }),
    );
    render(<SignupForm {...PROPS} />);

    submit();

    expect(await screen.findByText('Too many signup attempts. Try again in 12 minutes.')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument();
  });

  it('falls back to a generic message when the error response carries none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    render(<SignupForm {...PROPS} />);

    submit();

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('reports a network failure distinctly from a server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<SignupForm {...PROPS} />);

    submit();

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
  });

  it('clears a prior error once the teacher edits the email again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    render(<SignupForm {...PROPS} />);

    submit();
    await screen.findByText('Something went wrong. Please try again.');

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'retry@example.com' } });

    expect(screen.queryByText('Something went wrong. Please try again.')).not.toBeInTheDocument();
  });

  it('pre-fills the email from initialEmail', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<SignupForm {...PROPS} initialEmail="known@example.com" />);

    expect(screen.getByLabelText('Email')).toHaveValue('known@example.com');
  });
});
