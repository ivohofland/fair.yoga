import { test, expect, type BrowserContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher, accountIdOfStudent } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';

/**
 * #166 end to end, through the UI on both sides: a teacher may not link
 * themselves to a student unilaterally — the only way in is an `Invitation`
 * the invitee answers themselves.
 *
 * Two paths, one teacher, two students (an accepting one and a declining
 * one — the same address can't carry both, `Invitation` is
 * `@@unique([teacherId, email])`):
 *   1. add contact → student signs in, sees it on `/account/privacy`,
 *      accepts → the CRM lists them under Students, not Contacts.
 *   2. add a second contact → student declines → the CRM shows them
 *      Declined, under Contacts, with no remove affordance
 *      (`canRemoveContact`, `lib/contacts.ts`).
 *
 * No prior e2e spec drives `/students` at all, so this is also the first
 * coverage of that page through a real browser.
 */

const prisma = new PrismaClient();

const suffix = uniqueSuffix();
const teacherEmail = `e2e-invite-teacher-${suffix}@test.local`;
const acceptingEmail = `e2e-invite-accept-${suffix}@test.local`;
const decliningEmail = `e2e-invite-decline-${suffix}@test.local`;

let teacherId: string;
let acceptingStudentId: string;
let decliningStudentId: string;
let teacherAccountId: string;
let acceptingAccountId: string;
let decliningAccountId: string;
let teacherToken: string;
let acceptingToken: string;
let decliningToken: string;

async function signInAs(context: BrowserContext, token: string): Promise<void> {
  await context.clearCookies();
  await context.addCookies([sessionCookie(token)]);
}

test.describe('Invitations — add, accept, decline', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Invite',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Fixture for the #166 e2e invitation flow',
        pageSlug: `e2e-invite-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = await accountIdOfTeacher(prisma, teacherId);
    teacherToken = await seedSession(prisma, teacherAccountId);

    // Both students already hold an Account — #166 makes acceptance-gated
    // linking the only way IN, but signing in at all still requires a
    // pre-existing Account (`magic-link/send` looks up an existing
    // Teacher/Student by exact email, and does not create one). A genuinely
    // new invitee gets there via `/api/auth/student-signup` first; seeding
    // that step directly, like every other e2e spec's students, is what
    // this file's own scope is — the accept/decline path, not sign-up.
    const accepting = await prisma.student.create({
      data: {
        firstName: 'Accept',
        lastName: 'Real',
        email: acceptingEmail,
        account: { create: { email: acceptingEmail } },
        claimedAt: new Date(),
        incomeTier: 3,
      },
    });
    acceptingStudentId = accepting.id;
    acceptingAccountId = await accountIdOfStudent(prisma, acceptingStudentId);
    acceptingToken = await seedSession(prisma, acceptingAccountId);

    const declining = await prisma.student.create({
      data: {
        firstName: 'Decline',
        lastName: 'Real',
        email: decliningEmail,
        account: { create: { email: decliningEmail } },
        claimedAt: new Date(),
        incomeTier: 3,
      },
    });
    decliningStudentId = declining.id;
    decliningAccountId = await accountIdOfStudent(prisma, decliningStudentId);
    decliningToken = await seedSession(prisma, decliningAccountId);
  });

  test.afterAll(async () => {
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, acceptingAccountId, decliningAccountId] } },
    });
    // `notifyInvitee` (services/invitations.ts) fires a Notification for any
    // invitee who already has a Student row — both of this file's do — off
    // the request path. `recipientId` carries no FK, so nothing else reaps
    // these.
    await prisma.notification.deleteMany({
      where: { recipientType: 'student', recipientId: { in: [acceptingStudentId, decliningStudentId] } },
    });
    // Cascades Invitation, TeacherStudent and TeacherBlock rows this
    // teacher owns (all `onDelete: Cascade` from Teacher in schema.prisma).
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: [acceptingStudentId, decliningStudentId] } } });
    await prisma.account.deleteMany({
      where: { email: { in: [teacherEmail, acceptingEmail, decliningEmail] } },
    });
    await prisma.$disconnect();
  });

  test('add → accept moves a contact from Contacts to Students', async ({ page, context }) => {
    await signInAs(context, teacherToken);
    await page.goto('/students');
    await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible();

    await page.getByRole('link', { name: '+ Add contact' }).click();
    await expect(page.getByRole('heading', { name: 'New contact' })).toBeVisible();
    await page.getByLabel('First name').fill('Accept');
    await page.getByLabel('Last name').fill('Student');
    await page.getByLabel('Email').fill(acceptingEmail);
    await page.getByRole('button', { name: 'Send invitation' }).click();

    // The form confirms in place and names the address — it does not leave
    // for /students by itself, because the new row lands in a Contacts
    // section below an unchanged student directory and the flow read as a
    // failure without this.
    await expect(page.getByRole('heading', { name: 'Invitation sent' })).toBeVisible();
    await expect(page.getByText(acceptingEmail)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    // Back on /students — the new contact is pending, under Contacts.
    await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible();
    const contactsSection = page.locator('section').filter({ hasText: 'Contacts' });
    await expect(contactsSection.getByText('Accept Student')).toBeVisible();
    // Exact: the section's own caption also contains the substring
    // "invited" ("Contacts you've invited...").
    await expect(contactsSection.getByText('Invited', { exact: true })).toBeVisible();

    // The invitee signs in and answers it on their own privacy settings —
    // the only place a pending Invitation is ever answered (#166 task 11).
    await signInAs(context, acceptingToken);
    await page.goto('/account/privacy');
    await expect(page.getByRole('heading', { name: 'Pending invitations' })).toBeVisible();
    // h3, not a text match — the invitation's body copy also contains the
    // substring "Invite Teacher" ("Accepting lets Invite Teacher add...").
    await expect(page.getByRole('heading', { name: 'Invite Teacher' })).toBeVisible();
    await page.getByRole('button', { name: 'Accept' }).click();

    // The invitation drops off the pending list; the teacher now appears
    // under "Your teachers".
    await expect(page.getByRole('heading', { name: 'Pending invitations' })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your teachers' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Invite Teacher' })).toBeVisible();

    // Back to the teacher: the CRM now lists the real Student row under
    // Students, and the Contacts section no longer carries it — accepted
    // invitations are excluded there by construction (`isContact`,
    // contact-list.tsx), not merely relabelled.
    await signInAs(context, teacherToken);
    await page.goto('/students');
    // "Accept r." — the real Student row's own name, privacy-masked to a
    // last initial by default (`formatStudentName`, no `StudentPrivacy` row
    // exists yet). Distinct from "Accept Student", the Invitation's own
    // firstName/lastName typed into the form above, which `ContactList`
    // always renders in full (`formatStudentName(..., true)`).
    await expect(page.getByText('Accept r.')).toBeVisible();
    const contactsAfterAccept = page.locator('section').filter({ hasText: 'Contacts' });
    await expect(contactsAfterAccept.getByText('Accept Student')).toHaveCount(0);
    await expect(contactsAfterAccept.getByText('Accept r.')).toHaveCount(0);

    const link = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId: acceptingStudentId } },
    });
    expect(link.isArchived).toBe(false);
  });

  test('add → decline leaves a Declined contact with no remove button', async ({ page, context }) => {
    await signInAs(context, teacherToken);
    await page.goto('/students/new');
    await page.getByLabel('First name').fill('Decline');
    await page.getByLabel('Last name').fill('Student');
    await page.getByLabel('Email').fill(decliningEmail);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible();

    await signInAs(context, decliningToken);
    await page.goto('/account/privacy');
    await expect(page.getByRole('heading', { name: 'Invite Teacher' })).toBeVisible();

    // This student holds no link, so "Your teachers" is empty and its empty
    // state is on screen — in its with-pending-invitations wording here, and
    // in the other one after the decline below. Both must name BOTH routes
    // that connect a student to a teacher: booking a class AND joining a
    // waitlist, which has created the link since `addToWaitlist` started
    // upserting `TeacherStudent`. The page is an async server component
    // reading prisma, so the components Vitest project cannot render it and
    // e2e is the only place this claim can be pinned — which is how the
    // sentence came to name only booking for as long as it did (#166 review
    // F16).
    await expect(
      page.getByText('by booking a class or joining a waitlist'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Decline' }).click();
    await page.getByRole('button', { name: 'Decline invitation' }).click();
    await expect(page.getByRole('heading', { name: 'Pending invitations' })).not.toBeVisible();
    // The other branch of the same empty state, now that nothing is pending.
    await expect(page.getByText('Book a class or join a waitlist')).toBeVisible();
    // "Your teachers" itself always renders (it's the section header, shown
    // even when empty) — declining is not accepting: no teacher CARD forms
    // under it, so the name that headed the pending card above is gone from
    // the whole page, not just out of the pending list.
    await expect(page.getByRole('heading', { name: 'Invite Teacher' })).toHaveCount(0);

    await signInAs(context, teacherToken);
    await page.goto('/students');
    const contactsSection = page.locator('section').filter({ hasText: 'Contacts' });
    await expect(contactsSection.getByText('Decline Student')).toBeVisible();
    await expect(contactsSection.getByText('Declined')).toBeVisible();

    // The detail page is the only surface that ever renders a remove
    // affordance (`ContactList` rows don't) — `canRemoveContact` withholds
    // it for a declined row, on purpose: `PUT`/`DELETE /api/invitations/[id]`
    // both 409 `DECLINED_IS_PERMANENT` on it, and the button must be absent
    // rather than present-and-failing (#166 task 9 review). `reload()`
    // after the click forces a fresh server render for this check, rather
    // than trusting whatever the Link's own client-side navigation already
    // has in the router cache.
    await contactsSection.getByText('Decline Student').click();
    await page.waitForURL(/\/students\/contacts\//);
    await page.reload();
    await expect(page.getByText('Declined')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove contact' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive contact' })).toBeVisible();

    const link = await prisma.teacherStudent.findFirst({
      where: { teacherId, studentId: decliningStudentId },
    });
    expect(link).toBeNull();
  });
});
