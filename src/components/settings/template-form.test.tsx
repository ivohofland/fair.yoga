import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplateForm } from './template-form';
import { routerPush } from '../../../tests/setup/components';

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

  /**
   * Returns the URL and method alongside the parsed body — not just the body
   * — so a test can pin `calls.at(-1)` to the request it means. Without that,
   * an intervening `fetch` added later could make `.at(-1)` silently select
   * the wrong call while every body assertion still passed.
   */
  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    const button = await screen.findByRole('button', { name: /save|create/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('sends all thirteen fields when editing', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const { url, method, body } = await submit();
    expect(url).toBe('/api/class-templates/tpl-1');
    expect(method).toBe('PUT');
    expect(body).toEqual({
      teacherRoomId: '11111111-1111-4111-8111-111111111111',
      classType: 'Vinyasa',
      description: 'Bring a mat.',
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
    });
  });

  it('trims classType and description before sending', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const { body } = await submit();
    expect(body.classType).toBe('Vinyasa');
    expect(body.description).toBe('Bring a mat.');
  });

  it('sends a whitespace-only description as null', async () => {
    stubFetch();
    render(
      <TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial, description: '   ' }} />,
    );
    const { body } = await submit();
    expect(body.description).toBeNull();
  });

  /**
   * Create sends the same body to a different endpoint, and
   * `createClassTemplateSchema` requires fields the update one leaves optional
   * — so a body good enough for PUT can still be rejected by POST. Asserting
   * the key set on both modes is what makes the create-side pins in the source
   * file mean something at runtime: a forward pin (`_formCoversCreate`) that
   * every `CreateTemplateWire` field is in the form, and a reverse pin
   * (`_formHasNoExtrasOnCreate`) that the form sends nothing create would
   * silently strip. Both only guard the *key set* — the create and update
   * schemas agree on keys while differing in optionality and `.strict()` —
   * differences a key-set pin can't see, which is exactly what this runtime
   * assertion adds.
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
    const { url, method, body } = await submit();
    expect(url).toBe('/api/class-templates');
    expect(method).toBe('POST');
    expect(Object.keys(body).sort()).toEqual([
      'autoCancelCheck', 'cancelDeadline', 'classType', 'dayOfWeek', 'description',
      'durationMinutes', 'maxStudents', 'minRate', 'minStudents', 'roomCost',
      'startTime', 'targetRate', 'teacherRoomId',
    ]);
  });

  /**
   * #85's second half. These two fields were typed `string` against Prisma
   * enums of four and three members, so `update('cancelDeadline', 'HOURS_99')`
   * compiled. The dropdown arrays are now the single source of both the union
   * and the `<option>`s, so the two cannot disagree.
   *
   * This asserts the rendered options rather than the type, because the type is
   * held by the pins in the source file and a runtime test cannot see it. What
   * a runtime test *can* see is that every enum member is actually offered —
   * the failure a teacher would meet is a missing choice, not a type error.
   *
   * Narrower than the spec asked for, deliberately. The spec wanted a test of
   * "the enum guard rejecting a value outside the dropdown". The guards are
   * module-private, and exporting them only so a test can reach them is the
   * pattern PR #131's review rejected. Driving an invalid value through the
   * component is not possible either — the `<option>`s are the same array the
   * guard reads, so there is no way to select one it would refuse. What is
   * left is this: assert that the offered set equals the enum, which is the
   * property the guard exists to preserve.
   */
  it('offers every cancellation deadline the schema accepts', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const select = await screen.findByLabelText(/cancellation deadline/i);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values.sort()).toEqual(['HOURS_12', 'HOURS_24', 'HOURS_48', 'HOURS_6']);
  });

  it('offers every auto-cancel check the schema accepts', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const select = await screen.findByLabelText(/auto-cancel check/i);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values.sort()).toEqual(['HOURS_1', 'HOURS_2', 'HOURS_4']);
  });

  /**
   * `createClassTemplateSchema`'s and `updateClassTemplateSchema`'s
   * minRate/targetRate refine (schemas.ts) is mirrored by hand in
   * `handleSubmit`, because a client form cannot value-import zod without
   * shipping it to the browser. The pins in the source file cannot guard
   * that mirror — they compare key sets, not predicates — so this test is
   * the only thing that would notice it drifting from the schema.
   *
   * The room fetch fires on mount, so the fetch-not-called assertion checks
   * the call count did not increase across the click rather than that fetch
   * was never called at all.
   */
  it('rejects a min rate above target rate before any request is sent', async () => {
    stubFetch();
    render(
      <TemplateForm
        mode="edit"
        templateId="tpl-1"
        initial={{ ...initial, minRate: 30, targetRate: 25 }}
      />,
    );
    const button = await screen.findByRole('button', { name: /save|create/i });
    const callsBeforeSubmit = fetchMock.mock.calls.length;
    fireEvent.click(button);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSubmit);
    expect(await screen.findByText(/min rate cannot exceed target rate/i)).toBeInTheDocument();
  });

  /**
   * #40. POST /api/class-templates is not idempotent: a second request creates
   * a second template AND regenerates a second set of bookable classes. On
   * create this form pushed and reset `submitting` in a `finally`, so a push
   * that never committed left a populated, re-enabled form — and the obvious
   * second click duplicated the teacher's whole recurring schedule.
   *
   * The assertion is on the fetch count, not on rendered text: a partial fix
   * that only changes a label would satisfy a text assertion while still
   * allowing the second POST.
   */
  // G8
  it('cannot submit twice when the create push commits nothing', async () => {
    stubFetch();
    render(<TemplateForm mode="create" />);

    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Class type'), {
      target: { value: 'Vinyasa' },
    });

    const button = await screen.findByRole('button', { name: /create/i });
    fireEvent.click(button);

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/recurring'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    expect(screen.queryByRole('button', { name: /^create$/i })).toBeNull();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to recurring classes/i }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
    // Review F8. The settled action must re-issue the *same* navigation the
    // create did — the source held that path as two literals, and a drifted
    // second one would send the teacher somewhere the create never went while
    // every other assertion here still passed.
    expect(routerPush).toHaveBeenNthCalledWith(2, '/settings/recurring');
  });
});
