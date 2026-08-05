'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface StudentCountEditorProps {
  studioClassId: string;
  initialCount: number | null;
}

export function StudentCountEditor({ studioClassId, initialCount }: StudentCountEditorProps) {
  const router = useRouter();
  const [count, setCount] = useState(initialCount !== null ? String(initialCount) : '');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  async function handleSave() {
    setSaving(true);
    setSuccess('');
    setError('');
    try {
      const res = await fetch(`/api/studio-classes/${studioClassId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentCount: count === '' ? null : Number(count) }),
      });
      if (res.ok) {
        setSuccess('Saved');
        router.refresh();
      } else {
        // The worst of the four in this family (#166 re-review M5). The
        // other three leave an unchanged page; this one leaves the typed
        // number in the field with no "Saved" beside it — which is exactly
        // what an unclicked Save looks like, so a failure is not merely
        // invisible, it reads as a different state entirely.
        setError(await readErrorMessage(res, 'Could not save. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-end gap-3">
      <div className="flex-1">
        <Input
          label="Student count"
          type="number"
          min="0"
          value={count}
          onChange={(e) => { setCount(e.target.value); setSuccess(''); setError(''); }}
          placeholder="Enter after class"
        />
      </div>
      <Button variant="secondary" onClick={handleSave} disabled={saving} className="mb-0">
        {saving ? 'Saving...' : 'Save'}
      </Button>
      {/* One slot, never both: "Saved" and a failure describe the same click. */}
      {error
        ? <span className="type-caption text-danger mb-3.5">{error}</span>
        : success && <span className="type-caption text-teal mb-3.5">{success}</span>}
    </div>
  );
}
