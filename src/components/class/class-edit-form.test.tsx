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
    expect(body).toEqual({
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
    });
  });

  /**
   * Pins that the five economic keys do not reach the API when settings are
   * locked, by whatever mechanism the component uses to leave them out.
   *
   * This does not distinguish `delete payload[f]` from a hypothetical
   * `payload[f] = undefined`: `JSON.stringify` produces byte-identical output
   * for both, and this test only ever observes `JSON.parse(body)`. The route
   * itself would accept either — `updateClass` (`class-lifecycle.ts`) filters
   * on `data[f] !== undefined` when computing `sentEconomic` — so the two are
   * equivalent over the wire, and no test here tells them apart. Not that
   * none could: a spy on
   * `JSON.stringify` sees the object before it is serialized, where the two
   * differ. It would be testing the mechanism rather than what is sent, which
   * is why this file does not.
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

  /**
   * `updateClassSchema`'s minRate/targetRate refine (schemas.ts) is mirrored
   * by hand in `handleSave`, because a client form cannot value-import zod
   * without shipping it to the browser. The pins in the source file cannot
   * guard that mirror — they compare key sets, not predicates — so this test
   * is the only thing that would notice it drifting from the schema.
   */
  it('rejects a min rate above target rate before any request is sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm
        classId="cls-1"
        settingsLocked={false}
        initial={{ ...initial, minRate: 30, targetRate: 25 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/min rate cannot exceed target rate/i)).toBeInTheDocument();
  });
});
