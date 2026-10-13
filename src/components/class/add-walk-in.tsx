'use client';

import { EMAIL_MAX, NAME_MAX } from '@/lib/input-bounds';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Icon } from '@/components/ui/icon';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';

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

/**
 * One fetched list. Each list settles on its own, so a failure in one never
 * takes the other off the picker, and a failed list holds no rows to offer.
 * `loading` and a loaded-but-empty list both render no options; only the
 * latter may read "No student matches."
 */
type ListState<T> =
  | { status: 'loading' }
  | { status: 'loaded'; rows: T[] }
  | { status: 'failed' };

const LOADING = { status: 'loading' } as const;

function rowsOf<T>(list: ListState<T>): T[] {
  return list.status === 'loaded' ? list.rows : [];
}

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
  const [students, setStudents] = useState<ListState<RosterStudent>>(LOADING);
  const [invitees, setInvitees] = useState<ListState<PendingInvitee>>(LOADING);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Submit failures only. A list's load failure is its own `failed` state,
  // so a failed submit leaves the picker in place for the retry, and a
  // refetch that succeeds clears its list's message without touching this.
  const [error, setError] = useState('');

  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  // Fetches only — each list's state is set when its own request settles.
  // Opening the picker is what puts both lists back to `loading`
  // (`openPicker`), so a refetch while open keeps the current rows on screen
  // until its result replaces them. `registeredStudentIds` is a dependency:
  // a new array identity refetches both lists, which is how a picker that is
  // already open picks up a newly linked student.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    fetch('/api/students')
      .then((res) => {
        if (!res.ok) throw new Error(`students ${res.status}`);
        return res.json();
      })
      .then((json: { data: { students: RosterStudent[] } }) => {
        if (cancelled) return;
        setStudents({ status: 'loaded', rows: json.data.students });
      })
      .catch((err: unknown) => {
        logRequestFailure('add-walk-in-students', { classId }, err);
        if (cancelled) return;
        setStudents({ status: 'failed' });
      });

    fetch('/api/invitations?status=pending')
      .then((res) => {
        if (!res.ok) throw new Error(`invitations ${res.status}`);
        return res.json();
      })
      .then((json: { data: { invitations: PendingInvitee[] } }) => {
        if (cancelled) return;
        setInvitees({ status: 'loaded', rows: json.data.invitations });
      })
      .catch((err: unknown) => {
        logRequestFailure('add-walk-in-invitations', { classId }, err);
        if (cancelled) return;
        setInvitees({ status: 'failed' });
      });

    return () => {
      cancelled = true;
    };
  }, [open, registeredStudentIds, classId]);

  function openPicker() {
    setStudents(LOADING);
    setInvitees(LOADING);
    setOpen(true);
  }

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
    } catch (err) {
      logRequestFailure('add-walk-in-register', { classId }, err);
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
      <Button variant="secondary" onClick={openPicker} className="w-full sm:w-auto">
        <Icon name="plus" size={18} />
        Add walk-in
      </Button>
    );
  }

  // Registered students are filtered here, against the current prop, so the
  // refresh that registered one drops it before its refetch returns.
  const registered = new Set(registeredStudentIds);
  const options: PickerOption[] = [
    ...rowsOf(students)
      .filter((s) => !registered.has(s.id))
      .map((s) => ({ value: `student:${s.id}`, label: s.displayName })),
    ...rowsOf(invitees).map((i) => ({ value: `invitation:${i.id}`, label: inviteeLabel(i) })),
  ].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const query = filter.trim().toLowerCase();
  const visible = query
    ? options.filter((o) => nameOf(o).toLowerCase().includes(query))
    : options;

  const loaded = students.status !== 'loading' && invitees.status !== 'loading';
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
      {students.status === 'failed' && (
        <p role="alert" className="text-sm text-danger">
          Could not load your students.
        </p>
      )}
      {invitees.status === 'failed' && (
        <p role="alert" className="text-sm text-danger">
          Could not load your invited contacts.
        </p>
      )}

      <hr className="border-border" />

      <Input
        label="First name"
        value={newFirstName}
        maxLength={NAME_MAX}
        onChange={(e) => setNewFirstName(e.target.value)}
      />
      <Input
        label="Last name"
        value={newLastName}
        maxLength={NAME_MAX}
        onChange={(e) => setNewLastName(e.target.value)}
      />
      <Input
        label="Email"
        type="email"
        value={newEmail}
        maxLength={EMAIL_MAX}
        onChange={(e) => setNewEmail(e.target.value)}
      />
      <Button variant="secondary" onClick={handleAddNewPerson} disabled={newPersonDisabled}>
        {submitting ? 'Adding...' : 'Add new person'}
      </Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
