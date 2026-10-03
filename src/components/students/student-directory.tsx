'use client';

import { useEffect, useState } from 'react';
import { logRequestFailure } from '@/lib/client-errors';
import { Input, InputSkeleton } from '@/components/ui/input';
import { Icon } from '@/components/ui/icon';
import { ListRow, ListRowSkeleton } from '@/components/ui/list-row';
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

// The search field's wrapper, shared by the directory and its skeleton.
const SEARCH_WRAP = 'mb-4';

// Row count for both the directory's own initial-load state and
// `StudentDirectorySkeleton`'s default, so the two agree without either
// retyping the other's number.
const SKELETON_ROWS = 6;

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
        logRequestFailure('student-directory', {}, err);
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
  // The very first fetch, before any roster has ever rendered: there is
  // nothing yet to dim, so this gets the directory's own skeleton rows
  // instead of the opacity-50 treatment a reload with rows already on
  // screen gets below.
  const initialLoad = loading && students.length === 0 && !loadFailed;

  return (
    <div>
      <div className={SEARCH_WRAP}>
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

      <div className={loading && !initialLoad ? 'opacity-50' : ''}>
        {initialLoad ? (
          <div>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <ListRowSkeleton key={i} />
            ))}
          </div>
        ) : loadFailed && !loading ? (
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
              <ListRow
                key={student.id}
                href={`/students/${student.id}`}
                className="flex items-center gap-3 no-underline"
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
              </ListRow>
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

// The search field, then directory rows: a name line and an email line each.
export function StudentDirectorySkeleton({ rows = SKELETON_ROWS }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <div className={SEARCH_WRAP}>
        <InputSkeleton />
      </div>
      <div>
        {Array.from({ length: rows }, (_, i) => (
          <ListRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
