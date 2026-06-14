import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

// Self-contained smoke test: loads a local static HTML fixture (no Azure DevOps,
// no network) and exercises the same shape of interactions VeriFlow generates.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_URL = pathToFileURL(path.join(__dirname, 'fixture.html')).href;

test.describe('VeriFlow smoke', () => {
  test('heading is visible', async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await expect(page.locator('#heading')).toBeVisible();
    await expect(page.locator('#heading')).toContainText('VeriFlow');
  });

  test('search input accepts a query', async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.locator('input[name="search"]').fill('hello');
    await expect(page.locator('input[name="search"]')).toHaveValue('hello');
  });
});
