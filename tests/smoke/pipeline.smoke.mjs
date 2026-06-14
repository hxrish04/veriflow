// End-to-end smoke check for VeriFlow's new pipeline pieces WITHOUT Azure DevOps
// or any network: it writes a trivial passing Playwright spec against a local
// static HTML file, runs it through the sandbox runner, parses results.json,
// and builds the traceability matrix. Exits non-zero on any failure.
//
// Usage: node tests/smoke/pipeline.smoke.mjs
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { runSandboxedTests } from "../../server/sandbox.js";
import { buildTraceabilityMatrix } from "../../server/traceability.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The scratch work dir has no node_modules; point NODE_PATH at VeriFlow's own
// install so the generated config can resolve @playwright/test.
const repoModules = path.join(REPO_ROOT, "node_modules");
process.env.NODE_PATH = process.env.NODE_PATH
  ? `${repoModules}${path.delimiter}${process.env.NODE_PATH}`
  : repoModules;

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "veriflow-smoke-"));
const genDir = path.join(workDir, "generated");
await fs.mkdir(genDir, { recursive: true });

const fixtureUrl = pathToFileURL(path.join(__dirname, "fixture.html")).href;

await fs.writeFile(
  path.join(workDir, "playwright.config.js"),
  `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './generated',
  timeout: 30000,
  use: { headless: true },
  reporter: [['list'], ['json', { outputFile: 'generated/results.json' }]],
});
`,
  "utf8"
);

await fs.writeFile(
  path.join(genDir, "generated.spec.js"),
  `import { test, expect } from '@playwright/test';
const APP_URL = ${JSON.stringify(fixtureUrl)};
test.describe('Smoke', () => {
  test('Verify heading is visible on homepage', async ({ page }) => {
    await page.goto(APP_URL);
    await expect(page.locator('#heading')).toBeVisible();
  });
  test('Verify user can type a query into search input', async ({ page }) => {
    await page.goto(APP_URL);
    await page.locator('input[name="search"]').fill('hello');
    await expect(page.locator('input[name="search"]')).toHaveValue('hello');
  });
});
`,
  "utf8"
);

console.log(`[smoke] work dir: ${workDir}`);
const run = await runSandboxedTests({ cwd: workDir, timeout: 60000 });
console.log(`[smoke] sandbox mode: ${run.mode}`);

const resultsPath = path.join(genDir, "results.json");
let jsonReport;
try {
  jsonReport = JSON.parse(await fs.readFile(resultsPath, "utf8"));
} catch (err) {
  fail(`results.json was not produced/parseable: ${err.message}\n${run.stderr}`);
}

const stats = jsonReport.stats || {};
console.log(`[smoke] stats: expected=${stats.expected} unexpected=${stats.unexpected} skipped=${stats.skipped}`);
if (stats.expected !== 2 || stats.unexpected !== 0) {
  fail(`expected 2 passing / 0 failing, got expected=${stats.expected} unexpected=${stats.unexpected}\n${run.stdout}\n${run.stderr}`);
}

// Build a minimal report shape (matches what index.js feeds the matrix).
const tests = [];
const walk = (suite) => {
  for (const spec of suite.specs || []) {
    tests.push({ name: spec.title, status: spec.ok ? "passed" : "failed", duration: "n/a" });
  }
  for (const child of suite.suites || []) walk(child);
};
for (const suite of jsonReport.suites || []) walk(suite);

const context = {
  story: "As a user I want to search",
  url: fixtureUrl,
  criteria: "A heading is visible on the homepage\nA user can type a query into the search input",
};
const tracePath = path.join(genDir, "traceability.json");
const matrix = await buildTraceabilityMatrix({ context, report: { tests }, outPath: tracePath });

try {
  await fs.access(tracePath);
} catch {
  fail("traceability.json was not written");
}
if (matrix.requirementsTotal !== 2) fail(`expected 2 requirements, got ${matrix.requirementsTotal}`);
if (matrix.requirementsCovered < 2) fail(`expected both requirements covered, got ${matrix.requirementsCovered}`);

console.log(`[smoke] traceability: ${matrix.requirementsCovered}/${matrix.requirementsTotal} covered, ${matrix.requirementsPassing} passing`);
console.log("SMOKE PASS: results.json + traceability.json produced and parsed.");
await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
process.exit(0);
