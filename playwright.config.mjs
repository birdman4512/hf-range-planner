import { defineConfig } from '@playwright/test';

// Serves the static site and runs the smoke test against it.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  use: { baseURL: 'http://localhost:8080' },
  webServer: {
    command: 'npm run serve',
    url: 'http://localhost:8080/index.html',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
