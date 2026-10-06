import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('@/lib/session', () => ({ getSession }));
vi.mock('@/components/account/sign-out-button', () => ({
  SignOutButton: ({ accountId }: { accountId: string | null }) => (
    <span data-testid="sign-out" data-account-id={String(accountId)} />
  ),
}));
vi.mock('@/components/account/install-app-row', () => ({ InstallAppRow: () => null }));

import SettingsPage from './page';

describe('SettingsPage', () => {
  it('signs out as the session\'s account, so its queued attendance changes are sent', async () => {
    getSession.mockResolvedValue({ accountId: 'acct-1', teacherId: 'teacher-1', studentId: null });

    render(await SettingsPage());

    expect(screen.getByTestId('sign-out')).toHaveAttribute('data-account-id', 'acct-1');
  });
});
