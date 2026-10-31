import { test, expect } from './fixtures';

test.describe('Landing page', () => {
  test('fits a 375px phone without sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test('the hero sends a teacher to signup', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Set up your first class' }).first().click();
    await expect(page).toHaveURL(/\/signup$/);
  });

  test('back from signup returns to the features the visitor was reading', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /See what it does/ }).click();
    await expect(page).toHaveURL(/\/#features$/);
    await expect(page.locator('#features')).toBeInViewport();

    await page.getByRole('link', { name: 'Set up your first class' }).last().click();
    await expect(page).toHaveURL(/\/signup$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/#features$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^A free booking system/);
  });

  test('lays out its own column, wider than the app’s', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const panel = page.locator('#features').locator('.grid').first();
    const box = await panel.boundingBox();
    expect(box?.width).toBeGreaterThan(640);
  });
});
