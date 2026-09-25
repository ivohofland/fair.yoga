'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/students/pagination';

interface StudentRow {
  id: string;
  displayName: string;
  email: string | null;
  claimedAt: string | null;
  lastClassDate: string | null;
  classCount: number;
  overduePayments: number;
}

interface StudentListResponse {
  data: {
    students: StudentRow[];
  };
}

const PAGE_SIZE = 20;


interface StudentDirectoryProps {
  archived?: boolean;
}

export function StudentDirectory({ archived = false }: StudentDirectoryProps) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchStudents() {
      setLoading(true);
      setLoadFailed(false);
      try {
        const params = new URLSearchParams(archived ? { archived: 'true' } : {});
        const res = await fetch(`/api/students?${params}`);
        if (res.status === 401) {
          if (!cancelled) setLoadFailed(true);
          window.location.href = '/login';
          return;
        }
        if (!res.ok) {
          console.error('[student-directory] fetch failed', { status: res.status });
          if (!cancelled) setLoadFailed(true);
          return;
        }
        const json: StudentListResponse = await res.json();
        if (!cancelled) setStudents(json.data.students);
      } catch (err) {
        console.error('[student-directory] fetch failed', { err });
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchStudents();
    return () => {
      cancelled = true;
    };
  }, [archived]);

  const query = search.trim().toLowerCase();
  // A withheld email arrives as `null` (see `lib/student-visibility.ts`,
  // `TeacherVisibleStudent`), so it is simply absent from what this line
  // searches — no separate privacy check needed here.
  const filtered = query
    ? students.filter(
        (s) =>
          s.displayName.toLowerCase().includes(query) ||
          (s.email?.toLowerCase().includes(query) ?? false),
      )
    : students;
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="mb-4">
        <Input
          placeholder="Search by name or email"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          aria-label="Search students"
        />
      </div>

      <div className={loading ? 'opacity-50' : ''}>
        {loadFailed && !loading ? (
          <p role="alert" className="text-danger text-sm">
            Could not load your students.
          </p>
        ) : filtered.length === 0 && !loading ? (
          query ? (
            <EmptyState title={`No students matching '${search}'.`} />
          ) : archived ? (
            <EmptyState title="No archived students." />
          ) : (
            <EmptyState title="No students yet." body="Add your first student." />
          )
        ) : (
          <div>
            {visible.map((student) => (
              <Link
                key={student.id}
                href={`/students/${student.id}`}
                className="flex items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0 no-underline"
              >
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                  <span className="text-base text-ink font-medium">
                    {student.displayName}
                  </span>
                  {student.email && <span className="type-caption">{student.email}</span>}
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="type-caption">
                      {student.classCount} {student.classCount === 1 ? 'class' : 'classes'}
                    </span>
                    {student.overduePayments > 0 && (
                      <span className="type-caption text-danger">
                        {student.overduePayments} overdue
                      </span>
                    )}
                  </div>
                  {/*
                    An unclaimed row: no account is linked to it. Who creates
                    one: docs/data-model.md (Invitation → Walk-ins).
                  */}
                  {!student.claimedAt && (
                    <span className="type-caption">hasn&apos;t created an account yet</span>
                  )}
                </div>
                <Icon name="chevron-right" size={20} className="text-brown-light" />
              </Link>
            ))}
          </div>
        )}
      </div>

      <Pagination
        currentPage={page}
        totalPages={totalPages}
        onPageChange={setPage}
      />
    </div>
  );
}
