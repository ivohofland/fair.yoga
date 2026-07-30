import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ClassEditForm, type ClassEditInitial } from './class-edit-form';

/**
 * #81. This form used to enumerate its field list twice — once as
 * `ClassEditInitial`, once as the payload builder — under a comment claiming it
 * "Mirrors updateClassSchema exactly", which nothing checked. The list is now
 * single and compiler-pinned; what a pin cannot see is which keys actually
 * reach the API, and that is what these tests hold.
 *
 * The `settingsLocked` fork is the reason this file exists. It decides whether
 * five economic fields are sent, and getting it wrong means either a teacher
 * silently cannot edit their pricing, or a locked class accepts an edit the
 * route will reject with a 400.
 */
describe('ClassEditForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const initial: ClassEditInitial = {
    classType: 'Vinyasa',
    description: 'Bring a mat.',
    date: '2026-06-12',
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 4,
    maxStudents: 12,
  };

  async function saveWith(settingsLocked: boolean): Promise<Record<string, unknown>> {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
  }

  it('sends every editable field when settings are unlocked', async () => {
    const body = await saveWith(false);
    expect(Object.keys(body).sort()).toEqual([
      'classType', 'date', 'description', 'durationMinutes', 'maxStudents',
      'minRate', 'minStudents', 'roomCost', 'startTime', 'targetRate',
    ]);
  });

  /**
   * The five economic keys must be *absent*, not present-and-undefined. The
   * route filters on `data[f] !== undefined` (class-lifecycle.ts:467), so
   * either would pass server-side — but asserting absence pins the stronger
   * property and does not depend on that filter staying.
   */
  it('omits the economic fields when settings are locked', async () => {
    const body = await saveWith(true);
    expect(Object.keys(body).sort()).toEqual([
      'classType', 'date', 'description', 'durationMinutes', 'startTime',
    ]);
    for (const f of ['roomCost', 'minRate', 'targetRate', 'minStudents', 'maxStudents']) {
      expect(body).not.toHaveProperty(f);
    }
  });

  it('sends an empty description as null', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm
        classId="cls-1"
        settingsLocked={false}
        initial={{ ...initial, description: '' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as { body: string }).body) as Record<string, unknown>;
    expect(body.description).toBeNull();
  });
});
