'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import { formatStudentName } from '@/lib/format';

interface InvitationApiRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: 'pending' | 'accepted' | 'declined';
}

interface InvitationListResponse {
  data: {
    invitations: InvitationApiRow[];
  };
}

/**
 * The row shape this list actually renders — `status` narrowed to the two
 * values a contact still is one. `accepted` means the invitee is now a real
 * student: `acceptInvitation` (services/invitations.ts) or
 * `resolveInvitationOnLink` (services/link-consent.ts) already put them in
 * `TeacherStudent`, so they
 * render in `StudentDirectory` instead. The row survives in `Invitation` as
 * history, but showing it here too would list the same person under two
 * different labels on the same page.
 *
 * `GET /api/invitations` does not filter this out itself — it only takes
 * `?archived`, deliberately (see the route's own comment on why it has no
 * pagination either: a teacher's contacts are a working set, not a paged
 * directory). `isContact` below is the only place `accepted` gets excluded,
 * which is fine with the one caller this component has today. If a second
 * consumer needs the same distinction, give the route a `?status=` filter
 * mirroring `?archived=`, rather than copying this predicate into another
 * component — two places deciding "is this still a contact" is how the
 * definition drifts.
 */
interface ContactRow extends Omit<InvitationApiRow, 'status'> {
  status: 'pending' | 'declined';
}

function isContact(row: InvitationApiRow): row is ContactRow {
  return row.status !== 'accepted';
}

const STATUS_LABEL: Record<ContactRow['status'], string> = {
  pending: 'Invited',
  declined: 'Declined',
};

interface ContactListProps {
  archived?: boolean;
}

export function ContactList({ archived = false }: ContactListProps) {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * The only thing that separates "loaded, and you really have no contacts"
   * from "we could not ask" (review F6). Without it, a 500 bailed with
   * `contacts` still `[]` and `loading` false, and the component stated "No
   * contacts yet." — a confident falsehood about the teacher's own data, on
   * the page they land on straight after inviting someone.
   */
  const [failed, setFailed] = useState(false);
  // Bumped by "Try again" to re-run the effect. A counter rather than calling
  // the fetch directly: the effect owns the `cancelled` flag, so a retry that
  // bypassed it would be the one request nothing can cancel.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchContacts() {
      setLoading(true);
      try {
        const res = await fetch(archived ? '/api/invitations?archived=true' : '/api/invitations');
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (!res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const json: InvitationListResponse = await res.json();
        if (!cancelled) {
          setContacts(json.data.invitations.filter(isContact));
          setFailed(false);
        }
      } catch {
        // A rejected `fetch` (offline, DNS, a torn-down connection) used to
        // propagate straight out of the `try` with only the `finally` running,
        // which left the same "No contacts yet." on screen.
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchContacts();
    return () => {
      cancelled = true;
    };
  }, [archived, reloadKey]);

  return (
    <div className={loading ? 'opacity-50' : ''}>
      {failed ? (
        <EmptyState
          title="Could not load your contacts."
          action={
            // The v2 error state's ghost "Try again", same shape as the route
            // error boundary in `src/app/error.tsx`. Not `<Button>`: that one
            // is full-width below `sm`, which is too loud for a list that may
            // simply need asking again.
            <button
              type="button"
              onClick={() => setReloadKey((n) => n + 1)}
              disabled={loading}
              className="inline-flex items-center justify-center rounded-pill px-6 min-h-12 text-base font-semibold text-teal hover:bg-teal-tint"
            >
              Try again
            </button>
          }
        />
      ) : contacts.length === 0 && !loading ? (
        <EmptyState title={archived ? 'No archived contacts.' : 'No contacts yet.'} />
      ) : (
        <div>
          {contacts.map((contact) => (
            <Link
              key={contact.id}
              href={`/students/contacts/${contact.id}`}
              className="flex items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0 no-underline"
            >
              <div className="flex-1 min-w-0 flex flex-col gap-1">
                <span className="text-base text-ink font-medium">
                  {formatStudentName(contact.firstName, contact.lastName, true)}
                </span>
                {contact.email && <span className="type-caption">{contact.email}</span>}
              </div>
              <span className="type-caption">{STATUS_LABEL[contact.status]}</span>
              <Icon name="chevron-right" size={20} className="text-brown-light" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
