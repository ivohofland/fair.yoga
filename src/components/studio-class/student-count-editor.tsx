'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface StudentCountEditorProps {
  studioClassId: string;
  initialCount: number | null;
}

export function StudentCountEditor({ studioClassId, initialCount }: StudentCountEditorProps) {
  const router = useRouter();
  const [count, setCount] = useState(initialCount !== null ? String(initialCount) : '');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');

  async function handleSave() {
    setSaving(true);
    setSuccess('');
    try {
      const res = await fetch(`/api/studio-classes/${studioClassId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentCount: count === '' ? null : Number(count) }),
      });
      if (res.ok) {
        setSuccess('Saved');
        router.refresh();
      }
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
          onChange={(e) => { setCount(e.target.value); setSuccess(''); }}
          placeholder="Enter after class"
        />
      </div>
      <Button variant="secondary" onClick={handleSave} disabled={saving} className="mb-0">
        {saving ? 'Saving...' : 'Save'}
      </Button>
      {success && <span className="type-caption text-teal mb-3.5">{success}</span>}
    </div>
  );
}
