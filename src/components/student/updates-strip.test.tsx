import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { UpdatesStrip, type StudentUpdate } from './updates-strip';

function update(over: Partial<StudentUpdate>): StudentUpdate {
  return {
    id: 'u-1',
    title: 'Spot opened',
    body: 'Body',
    createdAt: '2026-09-15T10:00:00.000Z',
    href: null,
    ...over,
  };
}

const ALERT_TEXT = "Couldn't mark this message read.";

function markReadButton() {
  return screen.getByRole('button', { name: 'Mark "Spot opened" read' });
}

let errorSpy: { mockRestore: () => void };

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

describe('UpdatesStrip mark read (#670)', () => {
  it('marks read through the read route and refreshes the page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    render(<UpdatesStrip updates={[update({})]} hasHistory />);

    fireEvent.click(markReadButton());

    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/u-1/read', { method: 'POST' });
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so and does not refresh on a 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<UpdatesStrip updates={[update({})]} hasHistory />);

    fireEvent.click(markReadButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(ALERT_TEXT);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('says so when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<UpdatesStrip updates={[update({})]} hasHistory />);

    fireEvent.click(markReadButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(ALERT_TEXT);
  });

  it('refreshes on a 401 and still says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    render(<UpdatesStrip updates={[update({})]} hasHistory />);

    fireEvent.click(markReadButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(ALERT_TEXT);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('a retry clears the message when clicked, not when it succeeds', async () => {
    let release: (v: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockReturnValueOnce(new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    render(<UpdatesStrip updates={[update({})]} hasHistory />);

    fireEvent.click(markReadButton());
    await screen.findByRole('alert');

    fireEvent.click(markReadButton());

    expect(screen.queryByRole('alert')).toBeNull();

    release({ ok: false, status: 500 });

    expect((await screen.findByRole('alert')).textContent).toBe(ALERT_TEXT);

    fireEvent.click(markReadButton());

    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it('shows a message under every update whose mark failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(
      <UpdatesStrip
        updates={[update({}), update({ id: 'u-2', title: 'Second spot' })]}
        hasHistory
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Spot opened" read' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark "Second spot" read' }));

    await vi.waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
  });

  it('posts the mark from the title link when clicked, and sets the failed state on a failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    render(<UpdatesStrip updates={[update({ href: '/book/c-1' })]} hasHistory />);

    const link = screen.getByRole('link', { name: /^Spot opened/ });
    // jsdom cannot navigate; refusing the default keeps its warning out of the output.
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);

    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/u-1/read', { method: 'POST' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(ALERT_TEXT);
  });
});
