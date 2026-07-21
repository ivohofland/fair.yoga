'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { TIER_INFO, TIER_QUOTE } from '@/lib/tiers';

interface TierFormProps {
  studentId: string;
  currentTier: number;
}

// Tier selection. Your tier applies to every class you book; changing it
// is normal, not an event.
export function TierForm({ studentId, currentTier }: TierFormProps) {
  const [tier, setTier] = useState(currentTier);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await fetch(`/api/students/${studentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incomeTier: tier }),
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
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save tier'}
        </Button>
        {saved && <span className="type-caption text-teal">Saved</span>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
