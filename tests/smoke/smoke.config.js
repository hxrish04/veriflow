import { defineConfig } from '@playwright/test';

// Dedicated config for the self-contained smoke spec so CI can verify the
// pipeline without touching the AI-generated suite under ./generated.
export default defineConfig({
  testDir: '.',
  timeout: 30000,
  use: { headless: true },
  reporter: [
    ['list'],
    ['json', { outputFile: 'smoke-results.json' }],
  ],
});
