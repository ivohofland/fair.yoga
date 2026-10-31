import { test, expect } from './fixtures';

const PAGES = [
  { path: '/sliding-scale' },
  { path: '/donation-based' },
] as const;

test.describe('Pricing pages', () => {
  for (const { path } of PAGES) {
    test(`${path} fits a 375px phone without sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    });
  }

  test('?example=new-class opens with that chip pressed', async ({ page }) => {
    await page.goto('/sliding-scale?example=new-class');
    await expect(page.getByRole('button', { name: 'A new class' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'A typical class' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('choosing "A popular class" puts ?example=popular in the URL', async ({ page }) => {
    await page.goto('/sliding-scale');
    await page.getByRole('button', { name: 'A popular class' }).click();
    await expect(page).toHaveURL(/\?example=popular#examples$/);
    await expect(page.getByRole('button', { name: 'A popular class' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('Reset returns the students slider to the example', async ({ page }) => {
    await page.goto('/sliding-scale');
    const students = page.getByLabel('Students registered');
    await expect(students).toHaveValue('7');

    await students.fill('10');
    await expect(students).toHaveValue('10');

    await page.getByRole('button', { name: 'Reset to the example' }).click();
    await expect(students).toHaveValue('7');
    await expect(page.getByRole('button', { name: 'A typical class' })).toHaveAttribute('aria-pressed', 'true');
  });
});
