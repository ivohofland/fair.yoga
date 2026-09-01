'use client';

import { useState } from 'react';
import type { z } from 'zod';
import type { updateStudentSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { TIER_INFO, TIER_QUOTE, type IncomeTier } from '@/lib/tiers';

interface TierFormProps {
  studentId: string;
  /**
   * The stored tier, or null when it could not be read as one. Null shows
   * the picker with nothing selected: a tier we had to substitute is not
   * this student's choice, and must not be presented back as if it were.
   * Save stays disabled until they make one.
   */
  currentTier: IncomeTier | null;
}

type UpdateStudentWire = z.infer<typeof updateStudentSchema>;

interface TierBody {
  incomeTier: IncomeTier;
}

/**
 * #136. Reverse pin only — one key, and this form shares
 * `updateStudentSchema` with `notifications-form.tsx`. See that file for why
 * there is no forward pin.
 */
const _formHasNoExtras: NoneOf<Exclude<keyof TierBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;

// Tier selection. Your tier applies to every class you book; changing it
// is normal, not an event.
export function TierForm({ studentId, currentTier }: TierFormProps) {
  const [tier, setTier] = useState<IncomeTier | null>(currentTier);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (tier === null) return;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const payload: TierBody = { incomeTier: tier };
      const res = await fetch(`/api/students/${studentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
      } else {
        setError('Could not save. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <p className="type-body max-w-[420px]">
          Your price for every class is based on what you can comfortably
          contribute. Tiers are self-reported — no proof needed, and you can
          change yours here at any time.
        </p>
        <p className="type-caption font-heading italic mt-3 mb-4 max-w-[420px]">
          &ldquo;{TIER_QUOTE.text}&rdquo; — {TIER_QUOTE.author}
        </p>
        <div className="flex flex-col gap-3" role="radiogroup" aria-label="Income tier">
          {TIER_INFO.map((t) => {
            const selected = tier === t.tier;
            return (
              <button
                key={t.tier}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => { setTier(t.tier); setSaved(false); }}
                className={`text-left border rounded-card p-5 ${
                  selected ? 'bg-teal-tint border-teal' : 'bg-sand-soft border-border hover:bg-sand'
                }`}
              >
                <div className="type-label text-ink font-semibold">
                  Tier {t.tier} · {t.label}
                </div>
                <div className="type-caption mt-0.5">{t.caption}</div>
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={handleSave} disabled={saving || tier === null}>
          {saving ? 'Saving...' : 'Save tier'}
        </Button>
        {saved && <span className="type-caption text-teal">Saved</span>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
