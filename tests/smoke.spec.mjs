import { test, expect } from '@playwright/test';

// Smoke test: the app boots, modules load, no console/CSP errors, modes switch.
test('app loads, renders the map and switches modes without errors', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/index.html');

  // Title + sidebar present.
  await expect(page.locator('#brand h1')).toHaveText('HF Range Planner');
  // Band selector populated from bands.js.
  await expect(page.locator('#in-band option')).toHaveCount(10);
  // Leaflet map initialised (the leaflet-container class lands on #map itself).
  await expect(page.locator('#map.leaflet-container')).toBeVisible();
  await expect(page.locator('#map .leaflet-tile-pane')).toHaveCount(1);

  // Switch to Path mode.
  await page.click('#tab-path');
  await expect(page.locator('#mode-path')).toBeVisible();
  await expect(page.locator('#mode-coverage')).toBeHidden();

  // Ignore third-party tile/data fetch errors and benign meta-CSP notices;
  // fail only on genuine app errors.
  const appErrors = errors.filter((e) =>
    !/tile\.openstreetmap|services\.swpc|prop\.kc2g|favicon/i.test(e) &&
    !/delivered via a <meta> element/i.test(e));
  expect(appErrors, appErrors.join('\n')).toHaveLength(0);
});
