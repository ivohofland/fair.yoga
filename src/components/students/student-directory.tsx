'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { formatStudentName } from '@/lib/format';
import { Pagination } from '@/components/students/pagination';

interface StudentRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  claimedAt: string | null;
  shareFullName: boolean;
  lastClassDate: string | null;
  classCount: number;
}

interface StudentListResponse {
  data: {
    students: StudentRow[];
    total: number;
    page: number;
    pageSize: number;
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
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchStudents = useCallback(async (searchTerm: string, pageNum: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        search: searchTerm,
        page: String(pageNum),
        pageSize: String(PAGE_SIZE),
        ...(archived ? { archived: 'true' } : {}),
      });
      const res = await fetch(`/api/students?${params}`);
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!res.ok) return;
      const json: StudentListResponse = await res.json();
      setStudents(json.data.students);
      setTotal(json.data.total);
    } finally {
      setLoading(false);
    }
  }, [archived]);

  useEffect(() => {
    void fetchStudents(search, page);
  }, [fetchStudents, search, page]);

  function handleSearchChange(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, 300);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      <div className="mb-4">
        <Input
          placeholder="Search by name or email"
          defaultValue={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          aria-label="Search students"
        />
      </div>

      <div className={loading ? 'opacity-50' : ''}>
        {students.length === 0 && !loading ? (
          <p className="text-brown text-sm py-4">
            {search
              ? `No students matching '${search}'.`
              : archived ? 'No archived students.' : 'No students yet. Add your first student.'}
          </p>
        ) : (
          <div>
            {students.map((student) => (
              <Link
                key={student.id}
                href={`/students/${student.id}`}
                className="flex items-center justify-between py-3 border-b border-border"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-dark text-sm font-medium">
                    {formatStudentName(student.firstName, student.lastName, student.shareFullName)}
                  </span>
                  <span className="text-brown text-xs">{student.email}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-brown text-sm">
                    {student.classCount} {student.classCount === 1 ? 'class' : 'classes'}
                  </span>
                  {!student.claimedAt && (
                    <span className="text-xs text-brown opacity-60">unlinked</span>
                  )}
                </div>
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
