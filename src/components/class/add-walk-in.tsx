'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Icon } from '@/components/ui/icon';
import { readErrorMessage } from '@/lib/client-errors';

interface RosterStudent {
  id: string;
  displayName: string;
}

interface PendingInvitee {
  id: string;
  firstName: string;
  lastName: string;
}

interface AddWalkInProps {
  classId: string;
  /** Students already registered — filtered out of the picker. */
  registeredStudentIds: string[];
}

/** One row of the merged picker: a roster student or a pending invitee. */
interface PickerOption {
  value: string;
  label: string;
}

/** The subject half of `POST /api/registrations`'s body — `classId` is added by `submit`. */
type WalkInSubject =
  | { studentId: string }
  | { invitationId: string }
  | { newContact: { firstName: string; lastName: string; email: string } };

const INVITED_SUFFIX = ' · invited';

function inviteeLabel(invitee: PendingInvitee): string {
  return `${invitee.firstName} ${invitee.lastName}`.trim() + INVITED_SUFFIX;
}

/**
 * The name part of a picker option's label — what the filter matches
 * against, so typing a fragment of "invited" itself doesn't spuriously
 * match every invitee row.
 */
function nameOf(option: PickerOption): string {
  return option.label.endsWith(INVITED_SUFFIX)
    ? option.label.slice(0, -INVITED_SUFFIX.length)
    : option.label;
}

// The picker merges this teacher's roster with their pending invitations; a
// new person is added from the form below, which creates the contact and the
// registration at once.
//
// Walk-ins can exceed max_students: the teacher rate stays capped at target
// and extra students lower everyone's price.
//
// Fetches the whole roster and the whole pending-invitation list, and filters
// them locally by name — no pagination, no truncation.
export function AddWalkIn({ classId, registeredStudentIds }: AddWalkInProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [students, setStudents] = useState<RosterStudent[]>([]);
  const [invitees, setInvitees] = useState<PendingInvitee[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  // `loaded` (below) distinguishes "still fetching" from "fetched, and the
  // merged options (or the filtered view of them) are genuinely empty" —
  // both look like `visible.length === 0` otherwise, and only the latter
  // should ever read "No student matches." Each list has its own
  // loaded/failed pair, independent of the other: a failed invitations
  // fetch must not take the roster off the picker, and a failed roster
  // fetch must not take the invitees off it either — `options` below builds
  // from whichever of `students`/`invitees` its own fetch actually filled,
  // and each failure gets its own message underneath.
  const [studentsLoaded, setStudentsLoaded] = useState(false);
  // Carries its own message, independently of `error`: `error` carries only
  // submit failures. A failed submit must not hide the picker the teacher
  // is still using to retry — only a failed roster *load* should drop the
  // roster's contribution to it — and a roster load that succeeds after an
  // earlier failure must not leave a stale "Could not load" message next to
  // the now-current picker; keeping the message on `studentsFailed` (reset
  // every effect run, same as the gate) rather than on `error` (never reset
  // except by Close) keeps the two in lockstep.
  const [studentsFailed, setStudentsFailed] = useState(false);
  // Same shape as the `students` pair above, for the invitations fetch.
  const [invitationsLoaded, setInvitationsLoaded] = useState(false);
  const [invitationsFailed, setInvitationsFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStudentsLoaded(false);
    setStudentsFailed(false);
    setInvitationsLoaded(false);
    setInvitationsFailed(false);
    // A reopen's fetch can fail after an earlier open's succeeded — reset
    // both lists here, not only inside each `.then`, or a failed refetch
    // would leave the previous open's rows sitting in state, offered as
    // current beside the failure message below.
    setStudents([]);
    setInvitees([]);

    fetch('/api/students')
      .then((res) => {
        if (!res.ok) throw new Error(`students ${res.status}`);
        return res.json();
      })
      .then((json: { data: { students: RosterStudent[] } }) => {
        if (cancelled) return;
        const registered = new Set(registeredStudentIds);
        setStudents(json.data.students.filter((s) => !registered.has(s.id)));
        setStudentsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setStudentsFailed(true);
        // A failed load is still a load that finished — it must not keep
        // showing the loading (no-message) state forever.
        setStudentsLoaded(true);
      });

    fetch('/api/invitations?status=pending')
      .then((res) => {
        if (!res.ok) throw new Error(`invitations ${res.status}`);
        return res.json();
      })
      .then((json: { data: { invitations: PendingInvitee[] } }) => {
        if (cancelled) return;
        setInvitees(json.data.invitations);
        setInvitationsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setInvitationsFailed(true);
        setInvitationsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open, registeredStudentIds]);

  async function submit(subject: WalkInSubject): Promise<void> {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId, ...subject }),
      });
      if (res.ok) {
        setOpen(false);
        setSelected('');
        setNewFirstName('');
        setNewLastName('');
        setNewEmail('');
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

  function handleAdd() {
    if (!selected) return;
    if (selected.startsWith('invitation:')) {
      void submit({ invitationId: selected.slice('invitation:'.length) });
    } else if (selected.startsWith('student:')) {
      void submit({ studentId: selected.slice('student:'.length) });
    }
  }

  function handleAddNewPerson() {
    void submit({
      newContact: { firstName: newFirstName, lastName: newLastName, email: newEmail },
    });
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="w-full sm:w-auto">
        <Icon name="plus" size={18} />
        Add walk-in
      </Button>
    );
  }

  const options: PickerOption[] = [
    ...students.map((s) => ({ value: `student:${s.id}`, label: s.displayName })),
    ...invitees.map((i) => ({ value: `invitation:${i.id}`, label: inviteeLabel(i) })),
  ].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const query = filter.trim().toLowerCase();
  const visible = query
    ? options.filter((o) => nameOf(o).toLowerCase().includes(query))
    : options;

  const loaded = studentsLoaded && invitationsLoaded;
  const newPersonDisabled = newFirstName.trim() === '' || newEmail.trim() === '' || submitting;

  return (
    <div className="flex flex-col gap-3">
      <Input
        label="Filter students"
        placeholder="Filter by name"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setSelected('');
        }}
      />
      {loaded && visible.length > 0 && (
        <Select
          label="Walk-in student"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Choose a student…</option>
          {visible.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
      {/*
        Only when a typed filter is what emptied the list — a bare empty
        list shows nothing extra here, and loading/load-failure states show
        neither.
      */}
      {loaded && visible.length === 0 && query && (
        <p className="type-caption">No student matches.</p>
      )}
      <div className="flex gap-3">
        <Button variant="primary" onClick={handleAdd} disabled={!selected || submitting}>
          {submitting ? 'Adding...' : 'Add walk-in'}
        </Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setError(''); }}>
          Close
        </Button>
      </div>
      {studentsFailed && (
        <p role="alert" className="text-sm text-danger">
          Could not load your students.
        </p>
      )}
      {invitationsFailed && (
        <p role="alert" className="text-sm text-danger">
          Could not load your invited contacts.
        </p>
      )}

      <hr className="border-border" />

      <Input
        label="First name"
        value={newFirstName}
        onChange={(e) => setNewFirstName(e.target.value)}
      />
      <Input
        label="Last name"
        value={newLastName}
        onChange={(e) => setNewLastName(e.target.value)}
      />
      <Input
        label="Email"
        type="email"
        value={newEmail}
        onChange={(e) => setNewEmail(e.target.value)}
      />
      <Button variant="secondary" onClick={handleAddNewPerson} disabled={newPersonDisabled}>
        {submitting ? 'Adding...' : 'Add new person'}
      </Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
