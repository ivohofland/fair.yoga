import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplateForm } from './template-form';

/**
 * #85. This form enumerated its thirteen fields three times — the `initial`
 * prop, `INITIAL_VALUES`, and the PUT body — and nothing checked that the three
 * agreed with each other or with `updateClassTemplateSchema`. One list now,
 * compiler-pinned; these tests hold what a pin cannot see, which is what
 * actually reaches the API.
 *
 * The form fetches its room list on mount, so `fetch` is stubbed for every
 * test rather than only the saving ones. The first call is that room fetch;
 * the submit is the last call, which is why the assertions read
 * `mock.calls.at(-1)` rather than `calls[0]`.
 */
describe('TemplateForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const initial = {
    teacherRoomId: '11111111-1111-4111-8111-111111111111',
    classType: '  Vinyasa  ',
    description: '  Bring a mat.  ',
    dayOfWeek: 2,
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 4,
    maxStudents: 12,
    cancelDeadline: 'HOURS_24',
    autoCancelCheck: 'HOURS_2',
  } as const;

  function stubFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: '11111111-1111-4111-8111-111111111111',
          capacityOverride: 30,
          rentalRate: 20,
          room: { roomName: 'Studio A', venueName: 'Main Venue' },
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  async function submit(): Promise<Record<string, unknown>> {
    const button = await screen.findByRole('button', { name: /save|create/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const [, options] = fetchMock.mock.calls.at(-1) ?? [];
    return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
  }

  it('sends all thirteen fields when editing', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const body = await submit();
    expect(Object.keys(body).sort()).toEqual([
      'autoCancelCheck', 'cancelDeadline', 'classType', 'dayOfWeek', 'description',
      'durationMinutes', 'maxStudents', 'minRate', 'minStudents', 'roomCost',
      'startTime', 'targetRate', 'teacherRoomId',
    ]);
  });

  it('trims classType and description before sending', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const body = await submit();
    expect(body.classType).toBe('Vinyasa');
    expect(body.description).toBe('Bring a mat.');
  });

  it('sends a whitespace-only description as null', async () => {
    stubFetch();
    render(
      <TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial, description: '   ' }} />,
    );
    const body = await submit();
    expect(body.description).toBeNull();
  });

  /**
   * Create sends the same body to a different endpoint, and
   * `createClassTemplateSchema` requires fields the update one leaves optional
   * — so a body good enough for PUT can still be rejected by POST. Asserting
   * the key set on both modes is what makes the two create-side pins in the
   * source file mean something at runtime.
   */
  it('sends the same thirteen fields when creating', async () => {
    stubFetch();
    render(<TemplateForm mode="create" />);
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Class type'), {
      target: { value: 'Vinyasa' },
    });
    const body = await submit();
    expect(Object.keys(body).sort()).toEqual([
      'autoCancelCheck', 'cancelDeadline', 'classType', 'dayOfWeek', 'description',
      'durationMinutes', 'maxStudents', 'minRate', 'minStudents', 'roomCost',
      'startTime', 'targetRate', 'teacherRoomId',
    ]);
  });
});
