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
        if (!res.ok) return;
        const json: InvitationListResponse = await res.json();
        if (!cancelled) setContacts(json.data.invitations.filter(isContact));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchContacts();
    return () => {
      cancelled = true;
    };
  }, [archived]);

  return (
    <div className={loading ? 'opacity-50' : ''}>
      {contacts.length === 0 && !loading ? (
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
