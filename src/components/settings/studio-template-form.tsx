'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { createStudioClassTemplateSchema, updateStudioClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { SettledNotice } from '@/components/ui/settled-notice';
import {
  resumeStudioMessage,
  templateUpdatedMessage,
} from '@/components/settings/template-action-messages';
import type { TemplateGenerationState } from '@/lib/template-selection';
import { anyBlocked } from '@/lib/generation';
import { hasIntegerCounts } from '@/components/settings/template-action-messages';

/**
 * #136. The one enumeration of this form's fields. It replaced three that
 * nothing reconciled: this prop's inline type, `INITIAL_VALUES`, and the
 * request body. The pins below hold it against both wire schemas.
 */
export interface StudioTemplateFormValues {
  classType: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  location: string;
  hourlyRate: number;
}

type CreateStudioTemplateWire = z.infer<typeof createStudioClassTemplateSchema>;
type UpdateStudioTemplateWire = z.infer<typeof updateStudioClassTemplateSchema>;

/**
 * #136. Four pins, because one body serves both endpoints — the shape
 * `template-form.tsx` established. The two schemas agree on keys today; the
 * day they diverge, a pin against only one would not notice.
 */
const _formCoversCreate: NoneOf<Exclude<keyof CreateStudioTemplateWire, keyof StudioTemplateFormValues>> = true;
const _formCoversUpdate: NoneOf<Exclude<keyof UpdateStudioTemplateWire, keyof StudioTemplateFormValues>> = true;
const _formHasNoExtrasOnCreate: NoneOf<Exclude<keyof StudioTemplateFormValues, keyof CreateStudioTemplateWire>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof StudioTemplateFormValues, keyof UpdateStudioTemplateWire>> = true;
void _formCoversCreate;
void _formCoversUpdate;
void _formHasNoExtrasOnCreate;
void _formHasNoExtras;

interface StudioTemplateFormProps {
  mode: 'create' | 'edit';
  templateId?: string;
  initial?: StudioTemplateFormValues;
}

const DAY_OPTIONS = [
  { value: 0, label: 'Monday' },
  { value: 1, label: 'Tuesday' },
  { value: 2, label: 'Wednesday' },
  { value: 3, label: 'Thursday' },
  { value: 4, label: 'Friday' },
  { value: 5, label: 'Saturday' },
  { value: 6, label: 'Sunday' },
];

/**
 * #40 (whole-branch review F8). Written once, for the same reason as
 * `template-form.tsx`'s twin: the create push and the settled notice's retry
 * are one navigation, and a second literal is how they drift apart.
 */
const STUDIO_CLASSES_PATH = '/settings/studio-classes';

interface FormState {
  classType: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: string;
  location: string;
  hourlyRate: string;
}

function toFormState(initial?: StudioTemplateFormValues): FormState {
  return {
    classType: initial?.classType ?? '',
    dayOfWeek: initial?.dayOfWeek ?? 0,
    startTime: initial?.startTime ?? '09:00',
    durationMinutes: String(initial?.durationMinutes ?? 60),
    location: initial?.location ?? '',
    hourlyRate: String(initial?.hourlyRate ?? 0),
  };
}

export function StudioTemplateForm({ mode, templateId, initial }: StudioTemplateFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => toFormState(initial));
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSuccess('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // #40, corrected by whole-branch review F4. Defence-in-depth, on the same
    // reasoning as `template-form.tsx`'s twin: settlement removes the only
    // submit button, and implicit submission needs one — or a single field
    // that blocks it, where this form has five. Unreachable through the UI, so
    // a synthetic `fireEvent.submit` is what keeps it a guard rather than a
    // decoration.
    if (created) return;
    if (!form.classType.trim()) {
      setError('Class type is required.');
      return;
    }
    if (!form.location.trim()) {
      setError('Location is required.');
      return;
    }

    const duration = Number(form.durationMinutes);
    if (!form.durationMinutes.trim() || !Number.isInteger(duration) || duration <= 0) {
      setError('Enter how many minutes the class runs.');
      return;
    }

    const rate = Number(form.hourlyRate);
    if (!form.hourlyRate.trim() || Number.isNaN(rate) || rate < 0) {
      setError('Enter an hourly rate — 0 if this class is unpaid.');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const url = mode === 'create'
        ? '/api/studio-class-templates'
        : `/api/studio-class-templates/${templateId}`;
      const method = mode === 'create' ? 'POST' : 'PUT';

      // The intersection, not either half: one body goes to both endpoints, so
      // it has to satisfy both schemas. See template-form.tsx's identical
      // payload annotation for why this matters beyond the key-set pins above.
      const payload: CreateStudioTemplateWire & UpdateStudioTemplateWire = {
        classType: form.classType.trim(),
        location: form.location.trim(),
        dayOfWeek: form.dayOfWeek,
        startTime: form.startTime,
        durationMinutes: duration,
        hourlyRate: rate,
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to save');
        return;
      }

      if (mode === 'create') {
        // #40. A second identical POST to /api/studio-class-templates now
        // collides with `ScheduleRule_teacher_slot_excl` (issue 298) — an
        // `EXCLUDE USING gist` on (teacherId, dayOfWeek, slot) WHERE
        // isArchived = false, the constraint that replaced
        // `StudioClassTemplate_teacher_slot_unique` — and comes back as a
        // 409 DUPLICATE_STUDIO_TEMPLATE_SLOT
        // (`api/studio-class-templates/route.ts`) rather than a second
        // template and a second generated window. That backstop is
        // server-side and after the round trip, though — it does not stop
        // the second request from being sent, or turn its failure into
        // anything gentler than an error banner. The push below normally
        // unmounts this form; when it does not commit, `created` is what
        // stops a populated, re-enabled form from inviting the click that
        // resends the same create and now earns a 409 instead of a silent
        // duplicate.
        //
        // The POST also returns `added` and `counts` — the same shape the PATCH
        // `active` arm carries (#296 nested them). #196 made
        // `slotTaken` reachable here for the first time: a teacher
        // creating a recurring studio class onto a day/time they already
        // occupy gets a live template whose window came back short. A clean
        // window navigates straight to the list as before; a short one stays
        // on this page and says so, via the same `resumeStudioMessage` the
        // resume button renders — `scheduled` is exactly `added` here, since
        // nothing existed under this brand-new template before this create.
        //
        // `alreadyThisWeek` rides along inside `counts` — it is not a field of
        // this payload in its own right (#296) — and the GATE below covers it
        // like every other member, because `anyBlocked` (`@/lib/generation`)
        // reduces over `Object.values` rather than listing its terms. It is
        // structurally 0 on CREATE: the generator keys the reason on weeks
        // this template already holds (`isWeekHeld`,
        // `services/entry-generation.ts`), and a template created by this very
        // POST holds none. A provably-zero term is free — that is
        // `anyBlocked`'s own argument for reducing rather than enumerating,
        // and it is what makes the gate's job (the #196 failure: never
        // navigating away from a short window in silence) survive a count
        // nobody remembered to add.
        //
        // Structurally zero is a property of CREATE, not of the studio
        // generator — since #284 it produces `already_this_week` like the
        // class one, and the resume button meets it. Read from the wire rather
        // than hard-coded all the same, so the day a create path can reach a
        // held week the count is already here and the gate already reads it.
        // `counts` is optional in this parse shape even though the route always
        // sends it: this is untrusted JSON, and nesting means a payload without
        // the object would THROW on the first member read rather than compare
        // `undefined > 0` and fall through. The same distinction
        // `hasIntegerCounts` (`template-action-messages.ts`) exists for.
        const json: { data?: { added: number; counts?: unknown } } = await res.json();
        const result = json.data;
        setCreated(true);
        // `anyBlocked` rather than a hand-listed pair (`@/lib/generation`). This
        // gate enumerated its terms until #296 added `blockedByOverlap` —
        // the first such reason THE GATE DID NOT ALREADY LIST (`slotTaken` has
        // been reachable on create since #196, and the gate listed it) — and
        // then navigated away from a short window in silence. See that
        // function's docblock; the paragraph ABOVE is the rule it broke.
        if (result && Number.isInteger(result.added) && hasIntegerCounts(result.counts)) {
          if (anyBlocked(result.counts)) {
            setSuccess(resumeStudioMessage(result.added, result.added, result.counts));
          } else {
            router.push(STUDIO_CLASSES_PATH);
          }
        } else {
          // The payload did not survive the guard, so nothing here is known: not
          // whether the window is short, not what to say about it. Navigating is
          // the same thing this branch always did — what changes is that it is
          // no longer SILENT. Measured before this gate existed:
          // `anyBlocked(JSON.parse('{}'))` is `false`, so a `counts` that
          // arrived without its members took the clean-window path and this page
          // navigated away from a short window with no sentence, which is the
          // #296 failure at the one boundary its type cannot reach.
          //
          // WHICH payload that is: one that parses cleanly into the wrong shape
          // — a tab holding this bundle against a rolled-back server. NOT a
          // truncated body, which this comment named until PR #300's fourth
          // pass: `res.json()` sits inside the `try`, so a body that will not
          // parse throws to the outer `catch` and the teacher reads "Network
          // error" (`class-edit-form.tsx` records the same route) without ever
          // reaching this arm. A test pins the difference, because the first
          // version of this sentence was wrong and nothing could tell.
          //
          // `console.warn` rather than `log`: this is a `'use client'` file and
          // `lib/log.ts` says so.
          console.warn('recurring studio class create: unreadable counts on a 201, short-window check skipped', json);
          router.push(STUDIO_CLASSES_PATH);
        }
      } else {
        // Nothing to count: an edit changes the template row and no generated
        // studio class (#194), so there is no arrival, delete or kept tally to
        // report. What there IS to say is WHEN — the service probes for the
        // first week the new schedule reaches and sends its Monday back as
        // `firstEffective`, an ISO string on the wire (#284).
        //
        // `?? null` rather than a bare read, and the type says `string | null`
        // rather than `string`: `null` is what the service sends when no free
        // week is inside its horizon, `undefined` is what a server predating
        // this field sends, and `templateUpdatedMessage` answers both by
        // dropping the clause. Neither may become `new Date(undefined)`: it is
        // an Invalid Date, and `formatDayHeader` (`@/lib/format`) renders one
        // as "undefined, NaN undefined" in the middle of the sentence.
        //
        // `generationState` is the other half of the same sentence and cannot
        // be inferred from `firstEffective`: `null` means "no free week in
        // view" for a live template and "the sweep will never run" for a
        // paused or archived one, and only the service can tell them apart
        // (`@/lib/template-selection`). Re-deriving it here from the
        // `isActive`/`isArchived` columns this body also carries would put
        // another copy of the generator's eligibility gate in the copy layer.
        //
        // Narrowed by comparison rather than cast. This is wire data: a server
        // predating the field sends nothing, and anything unrecognised must
        // land on `'active'`, which is the plain sentence and the only one
        // safe to say about a template whose state we do not know. A cast
        // would hand an unknown string to an exhaustive `switch` that throws
        // on it — an unhandled error where a teacher expects a confirmation.
        //
        // `'template'` is this family's `TemplateCopyNoun` — the word its own
        // teacher-facing copy uses throughout, `UNARCHIVE_STUDIO_MESSAGE`
        // included. That type's docblock owns why the copy vocabulary is kept
        // apart from the log ones.
        const json: {
          data?: { firstEffective?: string | null; generationState?: string };
        } = await res.json();
        const firstEffective = json.data?.firstEffective ?? null;
        const wireState = json.data?.generationState;
        const generationState: TemplateGenerationState =
          wireState === 'paused' || wireState === 'archived' ? wireState : 'active';
        setSuccess(
          templateUpdatedMessage(
            firstEffective ? new Date(firstEffective) : null,
            generationState,
            'template',
          ),
        );
        router.refresh();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="Class type"
        value={form.classType}
        onChange={(e) => update('classType', e.target.value)}
        placeholder="e.g. Vinyasa, Hatha, Yin"
      />

      <Input
        label="Location"
        value={form.location}
        onChange={(e) => update('location', e.target.value)}
        placeholder="e.g. Yoga Studio Centrum, Amsterdam"
      />

      <Select
        id="dayOfWeek"
        label="Day"
        value={form.dayOfWeek}
        onChange={(e) => update('dayOfWeek', Number(e.target.value))}
      >
        {DAY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </Select>

      <Input
        label="Start time"
        type="time"
        value={form.startTime}
        onChange={(e) => update('startTime', e.target.value)}
      />

      <Input
        label="Duration (minutes)"
        type="number"
        value={form.durationMinutes}
        onChange={(e) => update('durationMinutes', e.target.value)}
      />

      <Input
        label="Hourly rate"
        type="number"
        step="0.01"
        value={form.hourlyRate}
        onChange={(e) => update('hourlyRate', e.target.value)}
      />

      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      {created ? (
        <SettledNotice
          label="Created"
          actionLabel="Go to studio classes"
          size="sm"
          onAction={() => router.push(STUDIO_CLASSES_PATH)}
        />
      ) : (
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
      )}
    </form>
  );
}
