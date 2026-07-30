/**
 * Setup for the vitest `components` project.
 *
 * Registers the jest-dom matchers and stubs `next/navigation`, so the test
 * files under `src/components/**` do not each redeclare `useRouter`. Deliberately
 * not a count: it was "six" until a seventh file depended on it, and a number
 * here goes stale every time someone adds a test. Testing-library's automatic
 * cleanup activates from `globals: true` in the root config, so no teardown
 * is wired here.
 *
 * The router mock returns both `refresh` and `push`: the template buttons call
 * `refresh()` to re-render the page they are on, the room and student buttons
 * call `push()` to navigate away. Tests that assert on either import them from
 * here.
 */
import '@testing-library/jest-dom/vitest';
import { vi, beforeEach } from 'vitest';

export const routerRefresh = vi.fn();
export const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: routerPush }),
}));

beforeEach(() => {
  routerRefresh.mockClear();
  routerPush.mockClear();
});
