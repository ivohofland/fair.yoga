/**
 * The room detail page's `canEditRoom` gate, on the control that opens a
 * one-way door.
 *
 * `canEditRoom` is `!room.isPublic && room.createdById === session.teacherId`,
 * and it decides three things at once: whether the room fields are editable,
 * whether Delete is offered, and — since #73 — whether `ShareRoomButton`
 * renders at all. Nothing tested the third. Dropping the gate offers "Share
 * with other teachers" on rooms the teacher did not create and on rooms that
 * are already shared; the route refuses both, so the damage is confined to
 * offering an action that cannot succeed — but this is the affordance for an
 * irreversible act, and an affordance that lies is its own defect.
 *
 * Both false arms are here on purpose. The gate is a conjunction, so a test
 * that only exercised one of them would pass against a gate that had lost the
 * other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const TEACHER_ID = 'teacher-1';
const OTHER_TEACHER_ID = 'teacher-2';

const { findUnique, count, requireTeacherSession, redirect } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  count: vi.fn(),
  requireTeacherSession: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: { teacherRoom: { findUnique }, class: { count } },
}));
vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import EditRoomPage from './page';

function room(over: Partial<{ isPublic: boolean; createdById: string }> = {}) {
  return {
    id: 'room-1',
    venueName: 'Yoga Loft',
    roomName: 'Studio A',
    address: 'Prinsengracht 42',
    city: 'Amsterdam',
    postcode: '1015DX',
    floor: '2',
    maxCapacity: 20,
    equipment: [],
    notes: null,
    isPublic: false,
    createdById: TEACHER_ID,
    ...over,
  };
}

function renderPage(overrides: Parameters<typeof room>[0] = {}) {
  requireTeacherSession.mockResolvedValue({ teacherId: TEACHER_ID });
  count.mockResolvedValue(0);
  findUnique.mockResolvedValue({
    id: 'tr-1',
    teacherId: TEACHER_ID,
    roomId: 'room-1',
    capacityOverride: 20,
    rentalRate: 15,
    equipmentNotes: null,
    isArchived: false,
    room: room(overrides),
  });
  return EditRoomPage({ params: Promise.resolve({ id: 'tr-1' }) });
}

beforeEach(() => { vi.clearAllMocks(); });

const SHARE = /Share with other teachers/;

describe('EditRoomPage — the share affordance', () => {
  it('offers sharing on a private room the teacher created', async () => {
    render(await renderPage());
    expect(screen.getByRole('button', { name: SHARE })).toBeDefined();
  });

  it('does not offer sharing on an already-shared room', async () => {
    render(await renderPage({ isPublic: true }));
    expect(screen.queryByRole('button', { name: SHARE })).toBeNull();
  });

  it('does not offer sharing on a room someone else created', async () => {
    render(await renderPage({ createdById: OTHER_TEACHER_ID }));
    expect(screen.queryByRole('button', { name: SHARE })).toBeNull();
  });
});
