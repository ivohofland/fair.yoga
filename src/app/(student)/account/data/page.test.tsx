import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('@/lib/session', () => ({ getSession }));
vi.mock('@/components/account/data-and-deletion', () => ({
  DataAndDeletion: ({ accountId }: { accountId: string }) => (
    <span data-testid="data-and-deletion" data-account-id={accountId} />
  ),
}));

import DataSettingsPage from './page';

describe('DataSettingsPage', () => {
  it('deletes as the session\'s account, so only its queued attendance changes are cleared', async () => {
    getSession.mockResolvedValue({ accountId: 'acct-1', teacherId: null, studentId: 'student-1' });

    render(await DataSettingsPage());

    expect(screen.getByTestId('data-and-deletion')).toHaveAttribute('data-account-id', 'acct-1');
  });
});
