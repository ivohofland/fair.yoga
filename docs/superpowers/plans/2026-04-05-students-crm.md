# Students CRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add teacher-facing student management — data model changes (TeacherStudent join table, claimedAt field), paginated/searchable student list API, student list page, and create student page.

**Architecture:** Prisma schema changes first, then API layer (GET + modified POST for /api/students), then UI components (pagination, student directory, create form), then page shells. Each layer builds on the previous.

**Tech Stack:** Prisma (schema + migration), Zod (validation), Next.js App Router (API routes + pages), React client components (search, pagination, form)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `claimedAt` to Student, add TeacherStudent model + relations |
| `src/lib/schemas.ts` | Modify | Add `studentListQuerySchema`, update `createStudentSchema` |
| `src/app/api/students/route.ts` | Modify | Add GET handler, rewrite POST for TeacherStudent logic |
| `src/components/students/pagination.tsx` | Create | Reusable pagination controls |
| `src/components/students/student-directory.tsx` | Create | Client component: search + list + pagination |
| `src/components/students/create-student-form.tsx` | Create | Client component: create student form |
| `src/app/(teacher)/students/page.tsx` | Create | Server shell for student list |
| `src/app/(teacher)/students/new/page.tsx` | Create | Server shell for create student form |
| `tests/integration/students-api.test.ts` | Create | Integration tests for GET + POST /api/students |

---

### Task 1: Prisma Schema Changes

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `claimedAt` field to Student model**

In `prisma/schema.prisma`, add `claimedAt` after the `emailNotifications` field on the Student model:

```prisma
  emailNotifications Boolean             @default(true)
  claimedAt          DateTime?
  createdAt          DateTime            @default(now())
```

- [ ] **Step 2: Add TeacherStudent model**

Add after the `StudentPrivacy` model (before the `// SPACES` section):

```prisma
model TeacherStudent {
  id        String   @id @default(uuid())
  teacherId String
  studentId String
  createdAt DateTime @default(now())

  teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)
  student Student @relation(fields: [studentId], references: [id], onDelete: Cascade)

  @@unique([teacherId, studentId])
}
```

- [ ] **Step 3: Add relation arrays to Teacher and Student**

On the `Teacher` model, add after the `createdRooms` line:

```prisma
  teacherStudents TeacherStudent[]
```

On the `Student` model, add after the `studentPrivacy` line:

```prisma
  teacherStudents TeacherStudent[]
```

- [ ] **Step 4: Run the migration**

Run: `npx prisma migrate dev --name add-teacher-student-crm`

Expected: Migration succeeds, creates `TeacherStudent` table and adds `claimedAt` column.

- [ ] **Step 5: Verify Prisma client generation**

Run: `npx prisma generate`

Expected: Prisma Client generated successfully.

- [ ] **Step 6: Commit**

```bash
git add prisma/
git commit -m "feat: add TeacherStudent join table and Student.claimedAt field"
```

---

### Task 2: Zod Schemas

**Files:**
- Modify: `src/lib/schemas.ts`

- [ ] **Step 1: Add `studentListQuerySchema`**

In `src/lib/schemas.ts`, add after the `updatePrivacySchema` export:

```typescript
export const studentListQuerySchema = z.object({
  search: z.string().optional().default(''),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(20),
});
```

- [ ] **Step 2: Remove `incomeTier` from `createStudentSchema`**

Teachers don't set income tier — that's the student's choice. Change `createStudentSchema` to:

```typescript
export const createStudentSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
});
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/schemas.ts
git commit -m "feat: add studentListQuerySchema, remove incomeTier from createStudentSchema"
```

---

### Task 3: GET /api/students Endpoint

**Files:**
- Modify: `src/app/api/students/route.ts`
- Test: `tests/integration/students-api.test.ts`

- [ ] **Step 1: Write the integration test for GET /api/students**

Create `tests/integration/students-api.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

let teacherId: string;
let studentIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'CRM',
      lastName: 'Teacher',
      email: `crm-teacher-${uniqueSuffix}@test.local`,
      bio: 'Teacher for CRM tests',
      pageSlug: `crm-teacher-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;

  // Create 25 students linked to this teacher
  for (let i = 0; i < 25; i++) {
    const student = await prisma.student.create({
      data: {
        firstName: `Student${String(i).padStart(2, '0')}`,
        lastName: 'Test',
        email: `crm-student-${uniqueSuffix}-${i}@test.local`,
      },
    });
    studentIds.push(student.id);
    await prisma.teacherStudent.create({
      data: { teacherId: teacher.id, studentId: student.id },
    });
  }

  // Create a student NOT linked to this teacher (should not appear)
  const unlinked = await prisma.student.create({
    data: {
      firstName: 'Unlinked',
      lastName: 'Student',
      email: `crm-unlinked-${uniqueSuffix}@test.local`,
    },
  });
  studentIds.push(unlinked.id);

  // Create a session for the teacher
  await prisma.session.create({
    data: {
      id: `crm-session-${uniqueSuffix}`,
      userId: teacherId,
      userType: 'teacher',
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
});

afterAll(async () => {
  await prisma.teacherStudent.deleteMany({
    where: { teacherId },
  });
  await prisma.session.deleteMany({
    where: { id: `crm-session-${uniqueSuffix}` },
  });
  await prisma.student.deleteMany({
    where: { id: { in: studentIds } },
  });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.$disconnect();
});

const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=crm-session-${uniqueSuffix}`;

describe('GET /api/students', () => {
  it('returns paginated students for the teacher', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=1&pageSize=10`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(10);
    expect(json.data.total).toBe(25);
    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(10);
  });

  it('returns page 3 with remaining students', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=3&pageSize=10`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(5);
    expect(json.data.total).toBe(25);
    expect(json.data.page).toBe(3);
  });

  it('filters by search term (name)', async () => {
    const res = await fetch(`${BASE_URL}/api/students?search=Student00`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(1);
    expect(json.data.students[0].firstName).toBe('Student00');
  });

  it('filters by search term (email)', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students?search=crm-student-${uniqueSuffix}-1@`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students.length).toBeGreaterThanOrEqual(1);
  });

  it('does not return students not linked to the teacher', async () => {
    const res = await fetch(`${BASE_URL}/api/students?search=Unlinked`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(0);
  });

  it('returns 401 without session', async () => {
    const res = await fetch(`${BASE_URL}/api/students`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/students-api.test.ts`

Expected: FAIL — GET /api/students returns 405 (no GET handler exists yet).

- [ ] **Step 3: Implement GET handler**

Replace the contents of `src/app/api/students/route.ts` with:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, requireTeacher, isErrorResponse, parseBody } from '@/lib/api-utils';
import { createStudentSchema, studentListQuerySchema } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = studentListQuerySchema.safeParse(params);
  if (!parsed.success) {
    return respondError('Invalid query parameters', 400);
  }

  const { search, page, pageSize } = parsed.data;

  const where = {
    teacherStudents: { some: { teacherId: session.userId } },
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [students, total] = await Promise.all([
    prisma.student.findMany({
      where,
      orderBy: { firstName: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        claimedAt: true,
        registrations: {
          where: { class: { teacherId: session.userId } },
          orderBy: { registeredAt: 'desc' },
          take: 1,
          select: { class: { select: { date: true } } },
        },
        _count: {
          select: {
            registrations: {
              where: { class: { teacherId: session.userId } },
            },
          },
        },
      },
    }),
    prisma.student.count({ where }),
  ]);

  const result = students.map((s) => ({
    id: s.id,
    firstName: s.firstName,
    lastName: s.lastName,
    email: s.email,
    claimedAt: s.claimedAt,
    lastClassDate: s.registrations[0]?.class.date ?? null,
    classCount: s._count.registrations,
  }));

  return respondOk({ students: result, total, page, pageSize });
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createStudentSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, email } = parsed.data;

  const existing = await prisma.student.findUnique({ where: { email } });

  if (existing) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.userId, studentId: existing.id } },
    });
    if (link) {
      return respondError('Student already in your contacts', 409, 'ALREADY_LINKED');
    }
    await prisma.teacherStudent.create({
      data: { teacherId: session.userId, studentId: existing.id },
    });
    return respondOk(existing, 200);
  }

  const student = await prisma.$transaction(async (tx) => {
    const created = await tx.student.create({
      data: { firstName, lastName, email },
    });
    await tx.teacherStudent.create({
      data: { teacherId: session.userId, studentId: created.id },
    });
    return created;
  });

  return respondOk(student, 201);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/integration/students-api.test.ts`

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/students/route.ts tests/integration/students-api.test.ts
git commit -m "feat: add GET /api/students with search and pagination, rewrite POST for TeacherStudent"
```

---

### Task 4: POST /api/students Integration Tests

**Files:**
- Modify: `tests/integration/students-api.test.ts`

- [ ] **Step 1: Add POST tests to the existing test file**

Append these tests inside the same file, after the GET describe block:

```typescript
describe('POST /api/students', () => {
  let createdStudentId: string;

  it('creates a new student and TeacherStudent link', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${uniqueSuffix}@test.local`,
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.firstName).toBe('New');
    createdStudentId = json.data.id;

    // Verify TeacherStudent link was created
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: createdStudentId } },
    });
    expect(link).not.toBeNull();
  });

  it('returns 409 when student already in contacts', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${uniqueSuffix}@test.local`,
      }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('ALREADY_LINKED');
  });

  it('links existing student to teacher without creating duplicate', async () => {
    // Create a second teacher
    const teacher2 = await prisma.teacher.create({
      data: {
        firstName: 'Second',
        lastName: 'Teacher',
        email: `crm-teacher2-${uniqueSuffix}@test.local`,
        bio: 'Second teacher',
        pageSlug: `crm-teacher2-${uniqueSuffix}`,
      },
    });
    const session2 = await prisma.session.create({
      data: {
        id: `crm-session2-${uniqueSuffix}`,
        userId: teacher2.id,
        userType: 'teacher',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    // Teacher 2 adds the same student by email
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_session=${session2.id}`,
      },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${uniqueSuffix}@test.local`,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(createdStudentId); // Same student, no duplicate

    // Cleanup teacher2
    await prisma.teacherStudent.deleteMany({ where: { teacherId: teacher2.id } });
    await prisma.session.delete({ where: { id: session2.id } });
    await prisma.teacher.delete({ where: { id: teacher2.id } });
  });

  it('returns 400 for invalid input', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ firstName: '', lastName: '', email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without session', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'No',
        lastName: 'Auth',
        email: 'noauth@test.local',
      }),
    });
    expect(res.status).toBe(401);
  });

  // Cleanup the created student
  afterAll(async () => {
    if (createdStudentId) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: createdStudentId } });
      await prisma.student.delete({ where: { id: createdStudentId } });
    }
  });
});
```

- [ ] **Step 2: Run all tests to verify they pass**

Run: `npx vitest run tests/integration/students-api.test.ts`

Expected: All 11 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/students-api.test.ts
git commit -m "test: add POST /api/students integration tests"
```

---

### Task 5: Pagination Component

**Files:**
- Create: `src/components/students/pagination.tsx`

- [ ] **Step 1: Create the pagination component**

Create `src/components/students/pagination.tsx`:

```tsx
'use client';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

function getPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 5) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | 'ellipsis')[] = [1];

  if (current > 3) {
    pages.push('ellipsis');
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 2) {
    pages.push('ellipsis');
  }

  pages.push(total);

  return pages;
}

export function Pagination({ currentPage, totalPages, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages = getPageNumbers(currentPage, totalPages);

  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-1 mt-6">
      <button
        type="button"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage <= 1}
        aria-label="Previous page"
        className="min-w-[44px] min-h-[44px] flex items-center justify-center text-brown disabled:opacity-30"
      >
        &larr;
      </button>

      {pages.map((page, idx) =>
        page === 'ellipsis' ? (
          <span key={`ellipsis-${idx}`} className="min-w-[44px] min-h-[44px] flex items-center justify-center text-brown">
            &hellip;
          </span>
        ) : (
          <button
            key={page}
            type="button"
            onClick={() => onPageChange(page)}
            aria-current={page === currentPage ? 'page' : undefined}
            className={`min-w-[44px] min-h-[44px] flex items-center justify-center text-sm ${
              page === currentPage
                ? 'font-bold text-teal'
                : 'text-brown'
            }`}
          >
            {page}
          </button>
        ),
      )}

      <button
        type="button"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
        aria-label="Next page"
        className="min-w-[44px] min-h-[44px] flex items-center justify-center text-brown disabled:opacity-30"
      >
        &rarr;
      </button>
    </nav>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/students/pagination.tsx
git commit -m "feat: add reusable Pagination component"
```

---

### Task 6: Student Directory Component

**Files:**
- Create: `src/components/students/student-directory.tsx`

- [ ] **Step 1: Create the student directory component**

Create `src/components/students/student-directory.tsx`:

```tsx
'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/students/pagination';

interface StudentRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  claimedAt: string | null;
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

function formatName(firstName: string, lastName: string): string {
  const lastInitial = lastName.length > 0 ? lastName[0] : '';
  return `${firstName} ${lastInitial ? lastInitial.toLowerCase() + '.' : ''}`.trim();
}

function formatDate(date: string): string {
  const d = new Date(date);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function StudentDirectory() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchStudents = useCallback(async (searchTerm: string, pageNum: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        search: searchTerm,
        page: String(pageNum),
        pageSize: String(PAGE_SIZE),
      });
      const res = await fetch(`/api/students?${params}`);
      if (!res.ok) return;
      const json: StudentListResponse = await res.json();
      setStudents(json.data.students);
      setTotal(json.data.total);
    } finally {
      setLoading(false);
    }
  }, []);

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
              : 'No students yet. Add your first student.'}
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
                    {formatName(student.firstName, student.lastName)}
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
```

- [ ] **Step 2: Commit**

```bash
git add src/components/students/student-directory.tsx
git commit -m "feat: add StudentDirectory component with search and pagination"
```

---

### Task 7: Students List Page

**Files:**
- Create: `src/app/(teacher)/students/page.tsx`

- [ ] **Step 1: Create the students page**

Create `src/app/(teacher)/students/page.tsx`:

```tsx
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { StudentDirectory } from '@/components/students/student-directory';

export default function StudentsPage() {
  return (
    <>
      <PageHeader title="Students" />
      <div className="mb-4">
        <Link href="/students/new" className="text-teal text-sm font-medium">
          + Add student
        </Link>
      </div>
      <StudentDirectory />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(teacher\)/students/page.tsx
git commit -m "feat: add /students list page"
```

---

### Task 8: Create Student Form Component

**Files:**
- Create: `src/components/students/create-student-form.tsx`

- [ ] **Step 1: Create the form component**

Create `src/components/students/create-student-form.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface FormErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
}

export function CreateStudentForm() {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const errs: FormErrors = {};
    if (!firstName.trim()) errs.firstName = 'First name is required';
    if (!lastName.trim()) errs.lastName = 'Last name is required';
    if (!email.trim()) {
      errs.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errs.email = 'Enter a valid email';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setSubmitting(true);
    setSubmitError('');

    try {
      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setSubmitError(json.error?.message ?? 'Failed to create student');
        return;
      }

      const json: { data: { id: string } } = await res.json();
      router.push(`/students/${json.data.id}`);
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="First name"
        value={firstName}
        onChange={(e) => {
          setFirstName(e.target.value);
          setErrors((prev) => ({ ...prev, firstName: undefined }));
        }}
        error={errors.firstName}
      />
      <Input
        label="Last name"
        value={lastName}
        onChange={(e) => {
          setLastName(e.target.value);
          setErrors((prev) => ({ ...prev, lastName: undefined }));
        }}
        error={errors.lastName}
      />
      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setErrors((prev) => ({ ...prev, email: undefined }));
        }}
        error={errors.email}
      />

      {submitError && <p className="text-sm text-error">{submitError}</p>}

      <div className="mt-4">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Adding...' : 'Add student'}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/students/create-student-form.tsx
git commit -m "feat: add CreateStudentForm component"
```

---

### Task 9: Create Student Page

**Files:**
- Create: `src/app/(teacher)/students/new/page.tsx`

- [ ] **Step 1: Create the page**

Create `src/app/(teacher)/students/new/page.tsx`:

```tsx
import { PageHeader } from '@/components/layout/page-header';
import { CreateStudentForm } from '@/components/students/create-student-form';

export default function NewStudentPage() {
  return (
    <>
      <PageHeader title="New student" backHref="/students" />
      <CreateStudentForm />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(teacher\)/students/new/page.tsx
git commit -m "feat: add /students/new page"
```

---

### Task 10: Add /students to Middleware Matcher

**Files:**
- Modify: `src/middleware.ts`

The `/students` route is inside the `(teacher)` route group, so the layout handles auth. But the middleware matcher should include it for consistent session checks before the page loads.

- [ ] **Step 1: Add `/students/:path*` to the matcher**

In `src/middleware.ts`, the matcher already has `/students/:path*`. Verify this is the case by reading the file. If not present, add it.

Run: Read `src/middleware.ts` and confirm `/students/:path*` is in the matcher array.

Expected: Already present from the original middleware config. No change needed.

- [ ] **Step 2: Verify the app builds**

Run: `npx next build`

Expected: Build succeeds with no type errors.

- [ ] **Step 3: Commit (if any changes)**

Only commit if middleware needed updating.

---

### Task 11: Update Seed Data for TeacherStudent

**Files:**
- Modify: `prisma/seed.ts`

- [ ] **Step 1: Add TeacherStudent cleanup to the delete block**

In `prisma/seed.ts`, add `await prisma.teacherStudent.deleteMany();` in the cleanup block, after `await prisma.studentPrivacy.deleteMany();` and before `await prisma.student.deleteMany();`:

```typescript
  await prisma.studentPrivacy.deleteMany();
  await prisma.teacherStudent.deleteMany();
  await prisma.student.deleteMany();
```

- [ ] **Step 2: Add TeacherStudent seed data after StudentPrivacy section**

After the `// STUDENT PRIVACY` section (after the `Promise.all` that creates privacy settings), add:

```typescript
  // ==========================================================================
  // TEACHER-STUDENT LINKS (CRM contacts)
  // ==========================================================================
  // All 10 students are in Ivo's contacts
  await Promise.all(
    students.map((student) =>
      prisma.teacherStudent.create({
        data: {
          teacherId: ivo.id,
          studentId: student.id,
        },
      }),
    ),
  );

  // Sarah has 3 students in her contacts (Anna, Clara, Eva)
  for (const idx of [0, 2, 4]) {
    await prisma.teacherStudent.create({
      data: {
        teacherId: sarah.id,
        studentId: students[idx]!.id,
      },
    });
  }
```

- [ ] **Step 3: Update the seed summary log**

Change the console.log summary to include TeacherStudent count:

```typescript
  console.log(`  TeacherStudents: 13 (10 for Ivo, 3 for Sarah)`);
```

Add this line after the `Students` line in the summary.

- [ ] **Step 4: Run the seed to verify**

Run: `npx prisma db seed`

Expected: Seed completes successfully with the new TeacherStudent data.

- [ ] **Step 5: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat: add TeacherStudent seed data for dev"
```
