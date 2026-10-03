import { test, expect } from '@playwright/test';

// Smoke test: the app boots, modules load, no console/CSP errors, modes switch.
test('app loads, renders the map and switches modes without errors', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/index.html');

  // Title + sidebar present.
  await expect(page.locator('#brand h1')).toHaveText('HF Range Planner');
  // Band toggle chips populated from bands.js.
  await expect(page.locator('#band-toggles .band-chip')).toHaveCount(11);
  // Station selects populated from bands.js / antenna.js / noise.js.
  await expect(page.locator('#in-mode option')).toHaveCount(5);
  await expect(page.locator('#in-ant option')).toHaveCount(4);
  await expect(page.locator('#in-noise option')).toHaveCount(4);
  // Leaflet map initialised (the leaflet-container class lands on #map itself).
  await expect(page.locator('#map.leaflet-container')).toBeVisible();
  await expect(page.locator('#map .leaflet-tile-pane')).toHaveCount(1);

  // Typing a Maidenhead locator places the TX and shows its coordinates + locator.
  await page.fill('#loc-tx', 'JO01ab');
  await page.press('#loc-tx', 'Enter');
  await expect(page.locator('#tx-coords')).toContainText('JO01ab');
  // Best-band view renders without errors and the station summary is filled in.
  await page.click('#view-best');
  await expect(page.locator('#view-best')).toHaveClass(/active/);
  await expect(page.locator('#station-summary')).toContainText('W');
  // The view is mirrored into the URL so it can be shared.
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('tx=');

  // Switch to Path mode.
  await page.click('#tab-path');
  await expect(page.locator('#mode-path')).toBeVisible();
  await expect(page.locator('#mode-coverage')).toBeHidden();

  // Ignore third-party tile/data fetch errors and benign meta-CSP notices;
  // fail only on genuine app errors.
  const appErrors = errors.filter((e) =>
    !/tile\.openstreetmap|services\.swpc|prop\.kc2g|raw\.githubusercontent|favicon|status of 404/i.test(e) &&
    !/delivered via a <meta> element/i.test(e));
  expect(appErrors, appErrors.join('\n')).toHaveLength(0);
});
