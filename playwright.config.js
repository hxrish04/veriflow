import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './generated',
  timeout: 30000,
  use: {
    headless: true,
  },
  // `list` for human-readable stdout logs; `json` writes an authoritative,
  // machine-parseable report (pass/fail/skipped counts) that the server reads
  // instead of scraping reporter text.
  reporter: [
    ['list'],
    ['json', { outputFile: 'generated/results.json' }],
  ],
});