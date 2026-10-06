/**
 * The room detail page's gates on the controls that open one-way doors: share,
 * delete and unlink. Share renders only where `canEditRoom` holds (#73); both
 * false arms are tested because the gate is a conjunction. Delete and Unlink
 * are offered only where the door's own counts would let the request through;
 * otherwise, on an archived room, the page says why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const TEACHER_ID = 'teacher-1';
const OTHER_TEACHER_ID = 'teacher-2';

const { findUnique, findTeacher, count, templateCount, requireTeacherSession, redirect } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findTeacher: vi.fn(),
  count: vi.fn(),
  templateCount: vi.fn(),
  requireTeacherSession: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: { teacher: { findUniqueOrThrow: findTeacher }, teacherRoom: { findUnique }, class: { count }, classTemplate: { count: templateCount } },
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

function renderPage(
  overrides: Parameters<typeof room>[0] = {},
  state: { isArchived?: boolean; classes?: number; templates?: number } = {},
) {
  requireTeacherSession.mockResolvedValue({ teacherId: TEACHER_ID });
  findTeacher.mockResolvedValue({ currency: 'EUR' });
  count.mockResolvedValue(state.classes ?? 0);
  templateCount.mockResolvedValue(state.templates ?? 0);
  findUnique.mockResolvedValue({
    id: 'tr-1',
    teacherId: TEACHER_ID,
    roomId: 'room-1',
    capacityOverride: 20,
    rentalRate: 15,
    equipmentNotes: null,
    isArchived: state.isArchived ?? false,
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

const DELETE = /Delete room/;
const UNLINK = /Unlink room/;
const DELETE_CAPTION = "This room is used by your classes or recurring classes, so it can't be deleted.";
const UNLINK_CAPTION = "This room is used by your classes or recurring classes, so it can't be unlinked.";

describe('EditRoomPage — Delete is offered only where the door will accept it', () => {
  it('offers Delete on an archived private room nothing points at', async () => {
    render(await renderPage({}, { isArchived: true }));
    expect(screen.getByRole('button', { name: DELETE })).toBeDefined();
    expect(screen.queryByText(DELETE_CAPTION)).toBeNull();
  });

  it('says why, and offers no Delete, when only a template points at the room', async () => {
    render(await renderPage({}, { isArchived: true, templates: 1 }));
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull();
    expect(screen.getByText(DELETE_CAPTION)).toBeDefined();
  });

  it('says why, and offers no Delete, when a class points at the room', async () => {
    render(await renderPage({}, { isArchived: true, classes: 1 }));
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull();
    expect(screen.getByText(DELETE_CAPTION)).toBeDefined();
  });

  it('offers neither Delete nor a caption on a private room that is not archived', async () => {
    render(await renderPage({}, { isArchived: false }));
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull();
    expect(screen.queryByText(DELETE_CAPTION)).toBeNull();
  });

  it('offers neither Delete nor a caption on an unarchived private room a class points at', async () => {
    render(await renderPage({}, { isArchived: false, classes: 1 }));
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull();
    expect(screen.queryByText(DELETE_CAPTION)).toBeNull();
  });

  it('counts room-wide for a private room', async () => {
    render(await renderPage({}, { isArchived: true }));
    expect(count).toHaveBeenCalledWith({ where: { teacherRoom: { roomId: 'room-1' } } });
    expect(templateCount).toHaveBeenCalledWith({ where: { teacherRoom: { roomId: 'room-1' } } });
  });
});

describe('EditRoomPage — Unlink is offered only where the door will accept it', () => {
  it('offers Unlink on a shared room nothing points at', async () => {
    render(await renderPage({ isPublic: true }));
    expect(screen.getByRole('button', { name: UNLINK })).toBeDefined();
    expect(screen.queryByText(UNLINK_CAPTION)).toBeNull();
  });

  it('says why, and offers no Unlink, when a template points at an archived shared room', async () => {
    render(await renderPage({ isPublic: true }, { isArchived: true, templates: 1 }));
    expect(screen.queryByRole('button', { name: UNLINK })).toBeNull();
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull();
    expect(screen.getByText(UNLINK_CAPTION)).toBeDefined();
    expect(screen.queryByText(DELETE_CAPTION)).toBeNull();
  });

  it('offers neither Unlink nor a caption on a shared room that is not archived and in use', async () => {
    render(await renderPage({ isPublic: true }, { isArchived: false, templates: 1 }));
    expect(screen.queryByRole('button', { name: UNLINK })).toBeNull();
    expect(screen.queryByText(UNLINK_CAPTION)).toBeNull();
  });

  it('offers Unlink but never Delete on an archived shared room nothing points at', async () => {
    render(await renderPage({ isPublic: true }, { isArchived: true }));
    expect(screen.getByRole('button', { name: UNLINK })).toBeDefined();
    expect(screen.queryByRole('button', { name: DELETE })).toBeNull();
    expect(screen.queryByText(UNLINK_CAPTION)).toBeNull();
    expect(screen.queryByText(DELETE_CAPTION)).toBeNull();
  });

  it('counts by link for a shared room', async () => {
    render(await renderPage({ isPublic: true }));
    expect(count).toHaveBeenCalledWith({ where: { teacherRoomId: 'tr-1' } });
    expect(templateCount).toHaveBeenCalledWith({ where: { teacherRoomId: 'tr-1' } });
  });
});
