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
 * student: `acceptInvitation` or `resolveInvitationOnLink` (both in
 * services/invitations.ts) already put them in `TeacherStudent`, so they
 * render in `StudentDirectory` instead. The row survives in `Invitation` as
 * history, but showing it here too would list the same person under two
 * different labels on the same page.
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

export function ContactList() {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchContacts() {
      setLoading(true);
      try {
        const res = await fetch('/api/invitations');
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
  }, []);

  return (
    <div className={loading ? 'opacity-50' : ''}>
      {contacts.length === 0 && !loading ? (
        <EmptyState title="No contacts yet." />
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
