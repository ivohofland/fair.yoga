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
import { resumeStudioMessage } from '@/components/settings/template-action-messages';
import type { SkipCounts } from '@/lib/generation';

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

const INITIAL_VALUES: StudioTemplateFormValues = {
  classType: '',
  dayOfWeek: 0,
  startTime: '09:00',
  durationMinutes: 60,
  location: '',
  hourlyRate: 0,
};

export function StudioTemplateForm({ mode, templateId, initial }: StudioTemplateFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(initial ?? INITIAL_VALUES);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
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
    if (!form.location.trim()) {
      setError('Location is required');
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
        ...form,
        classType: form.classType.trim(),
        location: form.location.trim(),
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
        // collides with `StudioClassTemplate_teacher_slot_unique`
        // ((teacherId, dayOfWeek, startTime) WHERE isArchived = false, #196)
        // and comes back as a 409 DUPLICATE_STUDIO_TEMPLATE_SLOT
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
        // The POST also returns `added`, `blockedByCancelled` and
        // `slotTaken` — the same counts the PATCH `active` arm carries.
        // #196 made `slotTaken` reachable here for the first time: a teacher
        // creating a recurring studio class onto a day/time they already
        // occupy gets a live template whose window came back short. A clean
        // window navigates straight to the list as before; a short one stays
        // on this page and says so, via the same `resumeStudioMessage` the
        // resume button renders — `scheduled` is exactly `added` here, since
        // nothing existed under this brand-new template before this create.
        //
        // `alreadyThisWeek` rides along inside `counts` — it is not a field of
        // this payload in its own right (#296) — and the GATE below
        // deliberately does not test it. It is structurally 0 on create twice
        // over: a brand-new template holds no week of its own yet, and the
        // studio generator has no week key to produce the reason with until
        // #284. A gate term that can never fire would read as a case this
        // page handles.
        //
        // Read from the wire rather than hard-coded so the count arrives on
        // its own when #284 lands. That is when this gate needs the term —
        // and it needs it only if #284 also makes the reason reachable on
        // CREATE, which the first of the two arguments above says it will
        // not. Without the term a short window would navigate away in
        // silence, which is the #196 failure this branch of the code exists
        // to answer.
        // `counts` is optional in this parse shape even though the route always
        // sends it: this is untrusted JSON, and nesting means a payload without
        // the object would THROW on the first member read rather than compare
        // `undefined > 0` and fall through. The same distinction
        // `hasIntegerCounts` (`template-action-messages.ts`) exists for.
        const json: { data?: { added: number; counts?: SkipCounts } } = await res.json();
        const result = json.data;
        setCreated(true);
        if (result?.counts && (result.counts.blockedByCancelled > 0 || result.counts.slotTaken > 0)) {
          setSuccess(resumeStudioMessage(result.added, result.added, result.counts));
        } else {
          router.push(STUDIO_CLASSES_PATH);
        }
      } else {
        setSuccess('Saved');
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
        value={String(form.durationMinutes)}
        onChange={(e) => update('durationMinutes', Number(e.target.value))}
      />

      <Input
        label="Hourly rate"
        type="number"
        step="0.01"
        value={String(form.hourlyRate)}
        onChange={(e) => update('hourlyRate', Number(e.target.value))}
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
