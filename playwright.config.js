import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './generated',
  timeout: 30000,
  use: {
    headless: true,
  },
  reporter: 'list',
});