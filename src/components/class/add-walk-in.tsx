'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Icon } from '@/components/ui/icon';
import { readErrorMessage } from '@/lib/client-errors';

interface RosterStudent {
  id: string;
  firstName: string;
  lastName: string;
}

interface AddWalkInProps {
  classId: string;
  /** Students already registered — filtered out of the picker. */
  registeredStudentIds: string[];
}

// Walk-ins can exceed max_students: the teacher rate stays capped at
// target and extra students lower everyone's price. Roster-only picker;
// creating a brand-new student mid-class goes through Students → New.
export function AddWalkIn({ classId, registeredStudentIds }: AddWalkInProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [students, setStudents] = useState<RosterStudent[]>([]);
  const [rosterTotal, setRosterTotal] = useState(0);
  const [selected, setSelected] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const PAGE_SIZE = 50;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(`/api/students?page=1&pageSize=${PAGE_SIZE}`)
      .then((res) => {
        if (!res.ok) throw new Error(`students ${res.status}`);
        return res.json();
      })
      .then((json: { data: { students: RosterStudent[]; total: number } }) => {
        if (cancelled) return;
        const registered = new Set(registeredStudentIds);
        setStudents(json.data.students.filter((s) => !registered.has(s.id)));
        setRosterTotal(json.data.total);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your students.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, registeredStudentIds]);

  async function handleAdd() {
    if (!selected) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId, studentId: selected }),
      });
      if (res.ok) {
        setOpen(false);
        setSelected('');
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not add the walk-in. Try again.'));
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="w-full sm:w-auto">
        <Icon name="plus" size={18} />
        Add walk-in
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="Walk-in student"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">Choose a student…</option>
        {students.map((s) => (
          <option key={s.id} value={s.id}>
            {s.firstName} {s.lastName}
          </option>
        ))}
      </Select>
      <p className="type-caption">
        Not in your students yet? Add them under Students first.
        {rosterTotal > PAGE_SIZE &&
          ` Showing your first ${PAGE_SIZE} students — find the rest under Students.`}
      </p>
      <div className="flex gap-3">
        <Button variant="primary" onClick={handleAdd} disabled={!selected || submitting}>
          {submitting ? 'Adding...' : 'Add walk-in'}
        </Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setError(''); }}>
          Close
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
