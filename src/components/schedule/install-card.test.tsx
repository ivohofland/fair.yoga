import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InstallSupport } from '@/lib/install-support';
import { routerRefresh } from '../../../tests/setup/components';

let support: InstallSupport = 'unknown';
let coarse = true;
const promptInstall = vi.fn();
vi.mock('@/components/layout/install-store', () => ({
  useInstallSupport: () => support,
  useCoarsePointer: () => coarse,
  installStore: { promptInstall: (...args: unknown[]) => promptInstall(...args) },
}));

type CardModule = typeof import('./install-card');
let InstallCard: CardModule['InstallCard'];
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<{ ok: boolean }>>();

function postedSteps(): string[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const body: unknown = JSON.parse(String(init?.body));
    return typeof body === 'object' && body !== null && 'step' in body ? String(body.step) : '';
  });
}

describe('InstallCard', () => {
  beforeEach(async () => {
    // The card keeps a once-per-page guard at module scope; a fresh module
    // per test keeps one test's post from silencing the next.
    vi.resetModules();
    ({ InstallCard } = await import('./install-card'));
    support = 'unknown';
    coarse = true;
    promptInstall.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing once dismissed, whatever the browser', () => {
    support = 'ios-safari';
    const { container } = render(<InstallCard dismissed />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['unknown', 'unsupported'] as const)('renders nothing when support is %s', (value) => {
    support = value;
    const { container } = render(<InstallCard dismissed={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays off a desktop browser that holds a prompt', () => {
    support = 'prompt';
    coarse = false;
    const { container } = render(<InstallCard dismissed={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the iOS steps, and Done records the dismissal', async () => {
    support = 'ios-safari';
    render(<InstallCard dismissed={false} />);
    expect(screen.getByRole('heading', { name: 'Use fair.yoga as an app' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    expect(screen.getByText('Tap Add.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    await waitFor(() => expect(postedSteps()).toEqual(['install']));
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('gives Done a teal hover step, not the brown one shared by Skip and Dismiss', () => {
    support = 'ios-safari';
    render(<InstallCard dismissed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));

    const done = screen.getByRole('button', { name: /^Done/ });
    expect(done).toHaveClass('hover:text-teal-hover');
    expect(done).not.toHaveClass('hover:text-brown');
  });

  it('moves focus to the revealed steps when Show me how opens them', () => {
    support = 'ios-safari';
    const { container } = render(<InstallCard dismissed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));

    const revealed = container.querySelector('[tabindex="-1"]');
    expect(revealed).not.toBeNull();
    expect(document.activeElement).toBe(revealed);
  });

  it('records the dismissal when the browser prompt is accepted', async () => {
    support = 'prompt';
    promptInstall.mockResolvedValue('accepted');
    const { container } = render(<InstallCard dismissed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(postedSteps()).toEqual(['install']));
    expect(routerRefresh).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the card on an accepted install even when the dismissal post fails, without refreshing', async () => {
    support = 'prompt';
    promptInstall.mockResolvedValue('accepted');
    fetchMock.mockResolvedValue({ ok: false });
    const { container } = render(<InstallCard dismissed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(postedSteps()).toEqual(['install']));
    expect(container).toBeEmptyDOMElement();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('opens the manual steps when the prompt reports unavailable', async () => {
    support = 'prompt';
    promptInstall.mockResolvedValue('unavailable');
    render(<InstallCard dismissed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(screen.getByText(/browser’s menu/)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records nothing when the browser prompt is cancelled', async () => {
    support = 'prompt';
    promptInstall.mockResolvedValue('dismissed');
    render(<InstallCard dismissed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(promptInstall).toHaveBeenCalled());
    // Let the awaited outcome settle before asserting nothing was posted.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the browser-menu route once the prompt is spent', () => {
    support = 'manual';
    render(<InstallCard dismissed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    expect(screen.getByText(/browser’s menu/)).toBeInTheDocument();
  });

  it('Dismiss records the dismissal', async () => {
    support = 'ios-safari';
    render(<InstallCard dismissed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the install card' }));
    await waitFor(() => expect(postedSteps()).toEqual(['install']));
  });

  it('retires itself once, quietly, inside the installed app', async () => {
    support = 'installed';
    const first = render(<InstallCard dismissed={false} />);
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    render(<InstallCard dismissed={false} />);

    await waitFor(() => expect(postedSteps()).toEqual(['install']));
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('does not self-retire on a desktop standalone window or tab', async () => {
    support = 'installed';
    coarse = false;
    render(<InstallCard dismissed={false} />);

    // Give the effect a tick to run; there is nothing to await success on,
    // so this asserts the negative stays true rather than racing a promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
