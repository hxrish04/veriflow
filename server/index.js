import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const GENERATED_DIR = path.join(ROOT, "generated");
const GENERATED_SPEC_PATH = path.join(GENERATED_DIR, "generated.spec.js");
const DATA_DIR = path.join(__dirname, "data");
const RUN_HISTORY_PATH = path.join(DATA_DIR, "run-history.json");
const MAX_RUN_HISTORY = 10;
const SCHEDULE_INTERVALS = {
  off: 0,
  "5m": 5 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

const app = express();
const port = process.env.PORT || 3001;
const execAsync = promisify(exec);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(ROOT, "client")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let scheduledRun = {
  intervalKey: "off",
  timer: null,
  active: false,
  lastRunAt: null,
  lastReport: null,
  nextRunAt: null,
};
let lastGenerationContext = null;
let runHistory = [];

function buildKnownScenario({ url, story, criteria }) {
  // These curated scenarios keep the demo flows stable when the same
  // requirements are regenerated repeatedly from the UI.
  const normalizedUrl = String(url || "").toLowerCase();
  const normalizedStory = String(story || "").toLowerCase();
  const normalizedCriteria = String(criteria || "").toLowerCase();

  const isExpandTestingValidation =
    normalizedUrl.includes("practice.expandtesting.com/form-validation") &&
    (normalizedStory.includes("error") ||
      normalizedStory.includes("validation") ||
      normalizedCriteria.includes("validation") ||
      normalizedCriteria.includes("error"));

  const isWikipediaSearch =
    normalizedUrl.includes("wikipedia.org") &&
    normalizedStory.includes("search") &&
    normalizedCriteria.includes("search input") &&
    normalizedCriteria.includes("submit") &&
    normalizedCriteria.includes("results");

  const isPythonHomepage =
    normalizedUrl.includes("python.org") &&
    (normalizedStory.includes("homepage") || normalizedStory.includes("main content")) &&
    (normalizedCriteria.includes("homepage loads") ||
      normalizedCriteria.includes("logo") ||
      normalizedCriteria.includes("branding")) &&
    normalizedCriteria.includes("navigation");

  const isInternetNavigation =
    normalizedUrl.includes("the-internet.herokuapp.com") &&
    normalizedStory.includes("click on links") &&
    normalizedCriteria.includes("link") &&
    normalizedCriteria.includes("navigate");

  if (isExpandTestingValidation) {
    return {
      testPlan:
        "Validate that the ExpandTesting form-validation page exposes the required fields, blocks invalid submissions, surfaces meaningful validation feedback, and preserves valid user input so a tester can clearly identify which fields still need correction.",
      testCases: [
        {
          id: "TC001",
          name: "Verify required form fields are visible",
          description: "Ensure the key required inputs and submit action are present before interaction begins.",
          steps: [
            "Navigate to the form validation page.",
            "Confirm the contact name, contact number, pickup date, and payment method controls are visible.",
            "Confirm the register button is visible.",
          ],
        },
        {
          id: "TC002",
          name: "Verify validation messages appear for empty required fields",
          description: "Submit the form without entering data and confirm the browser reports invalid required fields.",
          steps: [
            "Navigate to the form validation page.",
            "Submit the form with all required fields left empty.",
            "Confirm at least one invalid field is present and exposes a validation message.",
          ],
        },
        {
          id: "TC003",
          name: "Verify validation feedback is visible after submission",
          description: "Provide only partial valid data and confirm the remaining invalid fields are clearly flagged.",
          steps: [
            "Navigate to the form validation page.",
            "Enter a valid contact name and contact number.",
            "Submit the form without choosing a pickup date or payment method.",
            "Confirm the page shows validation guidance for the missing fields.",
          ],
        },
        {
          id: "TC004",
          name: "Verify user can identify fields needing correction",
          description: "Ensure valid entries stay intact while the invalid fields remain highlighted after submit.",
          steps: [
            "Navigate to the form validation page.",
            "Fill only the valid contact fields and submit the form.",
            "Confirm the missing date and payment method are still flagged.",
            "Confirm the previously entered valid values remain populated.",
          ],
        },
      ],
      playwrightCode: `import { test, expect } from '@playwright/test';

const APP_URL = 'https://practice.expandtesting.com/form-validation';

test.describe('Form Validation Error Messages', () => {
  function contactNameField(page) {
    return page.locator('input[name="ContactName"], input[name="contactname"]').first();
  }

  function contactNumberField(page) {
    return page.locator('input[name="contactnumber"]').first();
  }

  function pickupDateField(page) {
    return page.locator('input[name="pickupdate"], input[type="date"]').first();
  }

  function submitButton(page) {
    return page.getByRole('button', { name: /Register/i });
  }

  async function getValidationMessage(locator) {
    return locator.evaluate((el) => el.validationMessage);
  }

  test('TC001 - Verify required form fields are visible', async ({ page }) => {
    await page.goto(APP_URL);

    await expect(contactNameField(page)).toBeVisible();
    await expect(contactNumberField(page)).toBeVisible();
    await expect(pickupDateField(page)).toBeVisible();
    await expect(page.getByText(/Payment Method/i)).toBeVisible();
    await expect(submitButton(page)).toBeVisible();
  });

  test('TC002 - Verify validation messages appear for empty required fields', async ({ page }) => {
    await page.goto(APP_URL);

    await submitButton(page).click();

    const invalidFields = page.locator('input:invalid, select:invalid, textarea:invalid');
    const invalidFieldCount = await invalidFields.count();
    expect(invalidFieldCount).toBeGreaterThan(0);

    const firstInvalidField = invalidFields.first();
    const validationMessage = await getValidationMessage(firstInvalidField);
    expect(validationMessage.trim()).not.toBe('');
  });

  test('TC003 - Verify validation feedback is visible after submission', async ({ page }) => {
    await page.goto(APP_URL);

    await contactNameField(page).fill('Harish');
    await contactNumberField(page).fill('123-4567890');
    await submitButton(page).click();

    await expect(page.getByText('Please provide valid Date.')).toBeVisible();
    await expect(page.getByText('Please select the Paymeny Method.')).toBeVisible();

    const invalidFieldCount = await page.locator(':invalid').count();
    expect(invalidFieldCount).toBeGreaterThanOrEqual(2);
  });

  test('TC004 - Verify user can identify fields needing correction', async ({ page }) => {
    await page.goto(APP_URL);

    await contactNameField(page).fill('Harish');
    await contactNumberField(page).fill('123-4567890');
    await submitButton(page).click();

    await expect(page.getByText('Please provide valid Date.')).toBeVisible();
    await expect(page.getByText('Please select the Paymeny Method.')).toBeVisible();

    await expect(contactNameField(page)).toHaveValue('Harish');
    await expect(contactNumberField(page)).toHaveValue('123-4567890');
  });
});`,
    };
  }

  if (isWikipediaSearch) {
    return {
      testPlan:
        "Validate the Wikipedia homepage search flow by confirming the search box is visible, accepts input, and successfully navigates to relevant content when submitted by either Enter or the search action.",
      testCases: [
        {
          id: "TC001",
          name: "Verify search input field is visible on homepage",
          description: "Ensure the Wikipedia homepage exposes the main search input.",
          steps: [
            "Navigate to wikipedia.org.",
            "Confirm the search input field is visible.",
          ],
        },
        {
          id: "TC002",
          name: "Verify user can type a query into search input",
          description: "Ensure text entry works inside the search field.",
          steps: [
            "Navigate to wikipedia.org.",
            "Enter a search query.",
            "Confirm the input retains the typed value.",
          ],
        },
        {
          id: "TC003",
          name: "Verify search submission using Enter key",
          description: "Submit a search with Enter and confirm relevant content loads.",
          steps: [
            "Navigate to wikipedia.org.",
            "Type a search query.",
            "Press Enter.",
            "Confirm a matching article or results page is displayed.",
          ],
        },
        {
          id: "TC004",
          name: "Verify search submission using search button",
          description: "Submit a search with the search action and confirm relevant content loads.",
          steps: [
            "Navigate to wikipedia.org.",
            "Type a search query.",
            "Click the search button.",
            "Confirm a matching article or results page is displayed.",
          ],
        },
      ],
      playwrightCode: `import { test, expect } from '@playwright/test';

const APP_URL = 'https://wikipedia.org';

test.describe('Wikipedia Search Functionality', () => {
  function searchInput(page) {
    return page.locator('input[name="search"]').first();
  }

  function searchButton(page) {
    return page.locator('button[type="submit"]').first();
  }

  function articleHeading(page) {
    return page.locator('#firstHeading').first();
  }

  test('TC001 - Verify search input field is visible on homepage', async ({ page }) => {
    await page.goto(APP_URL);

    await expect(searchInput(page)).toBeVisible();
  });

  test('TC002 - Verify user can type a query into search input', async ({ page }) => {
    await page.goto(APP_URL);

    await searchInput(page).fill('Playwright testing');
    await expect(searchInput(page)).toHaveValue('Playwright testing');
  });

  test('TC003 - Verify search submission using Enter key', async ({ page }) => {
    await page.goto(APP_URL);

    await searchInput(page).fill('Artificial intelligence');
    await searchInput(page).press('Enter');

    await expect(page).toHaveURL(/wikipedia\\.org/);
    await expect(articleHeading(page)).toBeVisible();
    await expect(articleHeading(page)).toContainText(/Artificial intelligence/i);
  });

  test('TC004 - Verify search submission using search button', async ({ page }) => {
    await page.goto(APP_URL);

    await searchInput(page).fill('Machine learning');
    await searchButton(page).click();

    await expect(page).toHaveURL(/wikipedia\\.org/);
    await expect(articleHeading(page)).toBeVisible();
    await expect(articleHeading(page)).toContainText(/Machine learning/i);
  });
});`,
    };
  }

  if (isPythonHomepage) {
    return {
      testPlan:
        "Validate that the Python homepage loads as expected by checking visible branding, primary navigation, and meaningful main-page content so the flow demonstrates stable homepage coverage.",
      testCases: [
        {
          id: "TC001",
          name: "Verify homepage loads successfully",
          description: "Confirm the Python homepage responds and renders the expected shell.",
          steps: [
            "Navigate to python.org.",
            "Confirm the page loads successfully.",
            "Confirm the URL remains on the Python site.",
          ],
        },
        {
          id: "TC002",
          name: "Verify Python branding is visible",
          description: "Ensure the site logo or Python branding is visible in the header.",
          steps: [
            "Navigate to python.org.",
            "Confirm the Python logo or visible Python text is present.",
          ],
        },
        {
          id: "TC003",
          name: "Verify primary navigation is visible",
          description: "Ensure the main navigation menu is displayed to the user.",
          steps: [
            "Navigate to python.org.",
            "Confirm the primary navigation container is visible.",
            "Confirm multiple navigation links are present.",
          ],
        },
        {
          id: "TC004",
          name: "Verify main homepage content is displayed",
          description: "Ensure meaningful homepage content is visible below the header.",
          steps: [
            "Navigate to python.org.",
            "Confirm the main content region is visible.",
            "Confirm the page contains visible promotional or informational content.",
          ],
        },
      ],
      playwrightCode: `import { test, expect } from '@playwright/test';

const APP_URL = 'https://www.python.org';

test.describe('Python Homepage', () => {
  function primaryNav(page) {
    return page.locator('#mainnav, .mainnav, nav').first();
  }

  test('TC001 - Verify homepage loads successfully', async ({ page }) => {
    await page.goto(APP_URL);

    await expect(page).toHaveURL(/python\\.org/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('TC002 - Verify Python branding is visible', async ({ page }) => {
    await page.goto(APP_URL);

    await expect(page.getByRole('link', { name: /python/i }).first()).toBeVisible();
  });

  test('TC003 - Verify primary navigation is visible', async ({ page }) => {
    await page.goto(APP_URL);

    await expect(primaryNav(page)).toBeVisible();
    const navLinkCount = await primaryNav(page).locator('a').count();
    expect(navLinkCount).toBeGreaterThan(3);
  });

  test('TC004 - Verify main homepage content is displayed', async ({ page }) => {
    await page.goto(APP_URL);

    const mainContent = page.locator('#content, .content, .introduction, .medium-widget').first();
    await expect(mainContent).toBeVisible();
    await expect(page.locator('body')).toContainText(/Python|Download|Documentation|Community/i);
  });
});`,
    };
  }

  if (isInternetNavigation) {
    return {
      testPlan:
        "Validate basic navigation on The Internet by confirming visible links on the homepage, successful link traversal, changed destination URLs, and visible destination content after navigation.",
      testCases: [
        {
          id: "TC001",
          name: "Verify visible links are displayed on homepage",
          description: "Ensure the homepage renders a list of navigable links.",
          steps: [
            "Navigate to the-internet.herokuapp.com.",
            "Confirm visible links are present in the main list.",
          ],
        },
        {
          id: "TC002",
          name: "Verify user can click a visible link",
          description: "Click a visible homepage link and confirm navigation succeeds.",
          steps: [
            "Navigate to the homepage.",
            "Click a visible link from the main list.",
            "Confirm the browser navigates away from the homepage.",
          ],
        },
        {
          id: "TC003",
          name: "Verify clicking link navigates to different page",
          description: "Ensure a selected link changes the URL and loads a destination page.",
          steps: [
            "Navigate to the homepage.",
            "Click a known visible link.",
            "Confirm the URL changes to the linked destination.",
          ],
        },
        {
          id: "TC004",
          name: "Verify destination page displays visible heading or main content",
          description: "Ensure the destination page has meaningful visible content.",
          steps: [
            "Navigate to the homepage.",
            "Click a visible link.",
            "Confirm a page heading or main content container is visible.",
          ],
        },
        {
          id: "TC005",
          name: "Verify multiple links navigation workflow",
          description: "Navigate to more than one destination page from the homepage and confirm content loads each time.",
          steps: [
            "Navigate to the homepage.",
            "Open one visible link and confirm content loads.",
            "Return to the homepage.",
            "Open a second visible link and confirm content loads.",
          ],
        },
      ],
      playwrightCode: `import { test, expect } from '@playwright/test';

const APP_URL = 'https://the-internet.herokuapp.com';

test.describe('Link Navigation Tests', () => {
  function mainLinks(page) {
    return page.locator('ul li a');
  }

  async function openNamedLink(page, name) {
    await page.goto(APP_URL);
    const link = page.getByRole('link', { name }).first();
    await expect(link).toBeVisible();
    await link.click();
  }

  test('TC001 - Verify list of visible links is displayed on homepage', async ({ page }) => {
    await page.goto(APP_URL);

    await expect(mainLinks(page).first()).toBeVisible();
    const linkCount = await mainLinks(page).count();
    expect(linkCount).toBeGreaterThan(10);
  });

  test('TC002 - Verify user can click a visible link', async ({ page }) => {
    await page.goto(APP_URL);

    const link = page.getByRole('link', { name: 'Form Authentication' }).first();
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\\/login$/);
  });

  test('TC003 - Verify clicking link navigates to different page', async ({ page }) => {
    await openNamedLink(page, 'Checkboxes');

    await expect(page).toHaveURL(/checkboxes/);
  });

  test('TC004 - Verify destination page displays visible heading or main content', async ({ page }) => {
    await openNamedLink(page, 'Dropdown');

    await expect(page.locator('h3').first()).toBeVisible();
    await expect(page.locator('#content')).toBeVisible();
  });

  test('TC005 - Verify multiple links navigation workflow', async ({ page }) => {
    await openNamedLink(page, 'Checkboxes');
    await expect(page.locator('h3').first()).toBeVisible();

    await openNamedLink(page, 'Dropdown');
    await expect(page.locator('h3').first()).toBeVisible();
  });
});`,
    };
  }

  return null;
}

function buildPrompt({ url, story, criteria }) {
  return `You are a senior QA automation engineer specialising in Playwright.
Given the application URL, user story, and acceptance criteria below, produce:
1. testPlan - a concise paragraph describing the testing approach
2. testCases - an array of objects, each with { id, name, description, steps[] }
3. playwrightCode - a complete, runnable Playwright test file in JavaScript
Rules:
- Use ES module syntax only
- The very first line must be: import { test, expect } from '@playwright/test';
- Do NOT use require()
- Use @playwright/test only
- Include assertions
- Navigate to the URL at the start of each test
- Avoid hard-coded waits
- Do NOT include markdown fences
Return ONLY a single valid JSON object: { "testPlan": "...", "testCases": [...], "playwrightCode": "..." }
Application URL: ${url}
User Story: ${story}
Acceptance Criteria: ${criteria}`;
}

async function loadRunHistory() {
  try {
    const raw = await fs.readFile(RUN_HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    runHistory = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Failed to load run history:", err.message);
    }
    runHistory = [];
  }
}

async function saveRunHistory() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(RUN_HISTORY_PATH, JSON.stringify(runHistory, null, 2), "utf8");
}

function getTargetHost(url) {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function buildHistoryEntry(report, context) {
  return {
    id: report.finishedAt || report.startedAt || String(Date.now()),
    trigger: report.trigger,
    success: report.success,
    finishedAt: report.finishedAt,
    durationText: report.durationText,
    totals: report.totals,
    summary: report.summary,
    targetHost: getTargetHost(context?.url),
    story: context?.story || "",
  };
}

async function recordRun(report, context) {
  const entry = buildHistoryEntry(report, context);
  runHistory = [entry, ...runHistory.filter((item) => item.id !== entry.id)].slice(0, MAX_RUN_HISTORY);
  await saveRunHistory();
}

function parseDurationMs(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^([\d.]+)\s*(ms|s|m)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (unit === "ms") return Math.round(amount);
  if (unit === "s") return Math.round(amount * 1000);
  if (unit === "m") return Math.round(amount * 60 * 1000);
  return null;
}

function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "Unknown";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) {
    const seconds = ms / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }

  const minutes = ms / 60000;
  return `${minutes % 1 === 0 ? minutes.toFixed(0) : minutes.toFixed(1)}m`;
}

function buildReport({ success, stdout, stderr, startedAt, finishedAt, trigger = "manual" }) {
  const combined = `${stdout || ""}\n${stderr || ""}`;
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tests = [];
  let durationMs = finishedAt && startedAt ? finishedAt - startedAt : null;

  for (const line of lines) {
    // Playwright's list reporter can emit either unicode ticks/crosses or
    // plain "ok"/"x" tokens depending on the shell and environment.
    const passMatch = line.match(/(?:[\u2713\u221A]|ok)\s+\d+\s+(.+?)\s+\(([\d.]+\s*(?:ms|s|m))\)/i);
    if (passMatch) {
      tests.push({
        name: passMatch[1],
        status: "passed",
        duration: passMatch[2],
      });
      continue;
    }

    const failMatch = line.match(/(?:[\u2718x\u00D7]|fail|not ok)\s+\d+\s+(.+?)(?:\s+\(([\d.]+\s*(?:ms|s|m))\))?$/i);
    if (failMatch) {
      tests.push({
        name: failMatch[1],
        status: "failed",
        duration: failMatch[2] || "",
      });
      continue;
    }

    const durationMatch = line.match(/\(([\d.]+\s*(?:ms|s|m))\)/i);
    if (line.includes("passed") && durationMatch) {
      durationMs = parseDurationMs(durationMatch[1]) ?? durationMs;
    }
  }

  const passed = tests.filter((test) => test.status === "passed").length;
  const failed = tests.filter((test) => test.status === "failed").length;
  const total = tests.length || passed + failed;

  return {
    trigger,
    success,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
    durationMs,
    durationText: formatDuration(durationMs),
    totals: {
      total,
      passed,
      failed,
    },
    tests,
    stdout: stdout || "",
    stderr: stderr || "",
  };
}

function buildFallbackSummary(report, context) {
  const { totals, success, durationText, tests, trigger } = report;
  const appName = context?.story ? `"${context.story}"` : "the requested flow";
  const host = context?.url ? new URL(context.url).host.replace(/^www\./, "") : "the target site";
  const coveredChecks = tests
    .slice(0, 4)
    .map((test) => test.name.replace(/^.*?[\u203A>]\s*/, ""))
    .join(", ");

  if (success) {
    return `This ${trigger} run passed successfully in ${durationText}. All ${totals.passed} generated Playwright tests passed for ${host}, covering ${appName}${coveredChecks ? `, including ${coveredChecks}` : ""}.`;
  }

  if (totals.total === 0) {
    return `This ${trigger} run did not execute any tests for ${host}. The suite stopped before test execution began, so the issue is likely in configuration or runtime setup rather than in the acceptance criteria themselves.`;
  }

  return `This ${trigger} run finished in ${durationText} with ${totals.failed} failing test${totals.failed === 1 ? "" : "s"} out of ${totals.total} for ${host}. The generated suite ran, but at least one scenario needs investigation before the flow is ready to present.`;
}

async function generateRunSummary(report, context) {
  const { totals, success, durationText, tests, trigger } = report;
  const fallback = buildFallbackSummary(report, context);

  if (!process.env.ANTHROPIC_API_KEY) return fallback;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 180,
      messages: [
        {
          role: "user",
          content: `Write one short plain-English summary paragraph for a VeriFlow test run.
Keep it recruiter-friendly, factual, specific, and under 85 words.
Mention the target website, pass/fail outcome, count of tests, duration, whether this was a manual or scheduled run, and what the tests actually validated.
If all tests passed, make it sound polished and demo-ready, not generic.
If no tests ran, explain that clearly.
Do not use markdown.

Run data:
${JSON.stringify(
  {
    trigger,
    success,
    totals,
    durationText,
    tests: tests.slice(0, 8),
    context,
  },
  null,
  2
)}`,
        },
      ],
    });

    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();

    return text || fallback;
  } catch {
    return fallback;
  }
}

async function executeGeneratedTests(trigger = "manual") {
  try {
    await fs.access(GENERATED_SPEC_PATH);
  } catch {
    const report = {
      trigger,
      success: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      durationText: "0ms",
      totals: { total: 0, passed: 0, failed: 0 },
      tests: [],
      stdout: "",
      stderr: "No generated test file found.",
      summary: `No generated Playwright spec is available yet, so the ${trigger} run could not start.`,
    };

    return { success: false, error: "No generated test file found.", report };
  }

  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execAsync(`npx playwright test --reporter=list`, {
      cwd: ROOT,
      timeout: 60000,
    });
    const finishedAt = Date.now();
    const report = buildReport({ success: true, stdout, stderr, startedAt, finishedAt, trigger });
    report.context = lastGenerationContext;
    report.summary = await generateRunSummary(report, lastGenerationContext);
    await recordRun(report, lastGenerationContext);
    return { success: true, report };
  } catch (err) {
    const finishedAt = Date.now();
    const report = buildReport({
      success: false,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message,
      startedAt,
      finishedAt,
      trigger,
    });
    report.context = lastGenerationContext;
    report.summary = await generateRunSummary(report, lastGenerationContext);
    await recordRun(report, lastGenerationContext);
    return { success: false, report };
  }
}

function getScheduleState() {
  return {
    intervalKey: scheduledRun.intervalKey,
    active: scheduledRun.active,
    lastRunAt: scheduledRun.lastRunAt,
    lastReport: scheduledRun.lastReport,
    nextRunAt: scheduledRun.nextRunAt,
  };
}

function clearScheduledRun() {
  if (scheduledRun.timer) clearInterval(scheduledRun.timer);
  scheduledRun = {
    ...scheduledRun,
    intervalKey: "off",
    timer: null,
    active: false,
    nextRunAt: null,
  };
}

function startScheduledRun(intervalKey) {
  const intervalMs = SCHEDULE_INTERVALS[intervalKey];
  if (!intervalMs) {
    clearScheduledRun();
    return;
  }

  if (scheduledRun.timer) clearInterval(scheduledRun.timer);

  scheduledRun = {
    ...scheduledRun,
    intervalKey,
    active: true,
    // The UI countdown uses nextRunAt so users can see exactly when the next
    // automated execution is expected to fire.
    nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
    timer: setInterval(async () => {
      const result = await executeGeneratedTests("scheduled");
      scheduledRun.lastRunAt = new Date().toISOString();
      scheduledRun.lastReport = result.report;
      scheduledRun.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    }, intervalMs),
  };
}

app.get("/azure-stories", async (_req, res) => {
  const org = process.env.AZURE_DEVOPS_ORG;
  const pat = process.env.AZURE_DEVOPS_PAT;
  const project = process.env.AZURE_DEVOPS_PROJECT;

  if (!org || !pat || !project) {
    return res.status(400).json({ error: "Azure DevOps credentials not configured in .env" });
  }

  const auth = Buffer.from(`:${pat}`).toString("base64");

  try {
    const wiqlRes = await fetch(`https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=7.0`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "SELECT [System.Id], [System.Title], [System.Description] FROM workitems WHERE [System.WorkItemType] = 'Issue' OR [System.WorkItemType] = 'User Story' ORDER BY [System.CreatedDate] DESC",
      }),
    });

    const wiqlData = await wiqlRes.json();
    if (!wiqlData.workItems || wiqlData.workItems.length === 0) return res.json([]);

    const ids = wiqlData.workItems.slice(0, 10).map((workItem) => workItem.id).join(",");
    const detailsRes = await fetch(`https://dev.azure.com/${org}/${project}/_apis/wit/workitems?ids=${ids}&fields=System.Id,System.Title,System.Description&api-version=7.0`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const detailsData = await detailsRes.json();

    res.json(
      detailsData.value.map((item) => ({
        id: item.id,
        title: item.fields["System.Title"],
        description: item.fields["System.Description"] || "",
      }))
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Azure stories", detail: err.message });
  }
});

app.post("/generate-tests", async (req, res) => {
  const { url, story, criteria, sourceType = "manual", sourceLabel = "Manual Input" } = req.body;
  if (!url || !story || !criteria) {
    return res.status(400).json({ error: "url, story, and criteria are required." });
  }

  try {
    const knownScenario = buildKnownScenario({ url, story, criteria });
    if (knownScenario) {
      // Known demo scenarios bypass model generation so the app can return
      // reliable Playwright coverage for showcase flows.
      await fs.mkdir(GENERATED_DIR, { recursive: true });
      await fs.writeFile(GENERATED_SPEC_PATH, knownScenario.playwrightCode, "utf8");
      lastGenerationContext = { url, story, criteria, sourceType, sourceLabel };
      return res.json({ ...knownScenario, specPath: GENERATED_SPEC_PATH, curated: true });
    }

    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 3000,
      messages: [{ role: "user", content: buildPrompt({ url, story, criteria }) }],
    });

    const raw = msg.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(400).json({ error: "Claude did not return valid JSON.", raw });
    }

    await fs.mkdir(GENERATED_DIR, { recursive: true });
    await fs.writeFile(GENERATED_SPEC_PATH, parsed.playwrightCode, "utf8");
    lastGenerationContext = { url, story, criteria, sourceType, sourceLabel };

    res.json({ ...parsed, specPath: GENERATED_SPEC_PATH });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate tests.", detail: err.message });
  }
});

app.post("/run-tests", async (_req, res) => {
  const result = await executeGeneratedTests("manual");
  if (result.error) return res.status(400).json({ error: result.error, report: result.report });
  res.json({ success: result.success, report: result.report });
});

app.get("/generated-code", async (_req, res) => {
  try {
    const code = await fs.readFile(GENERATED_SPEC_PATH, "utf8");
    res.json({ code });
  } catch {
    res.json({ code: "" });
  }
});

app.get("/run-history", (_req, res) => {
  res.json({ items: runHistory });
});

app.get("/schedule", (_req, res) => {
  res.json(getScheduleState());
});

app.post("/schedule", async (req, res) => {
  const { intervalKey } = req.body || {};

  if (!(intervalKey in SCHEDULE_INTERVALS)) {
    return res.status(400).json({ error: "intervalKey must be one of off, 5m, 30m, 1h." });
  }

  try {
    if (intervalKey === "off") {
      clearScheduledRun();
    } else {
      await fs.access(GENERATED_SPEC_PATH);
      startScheduledRun(intervalKey);
    }

    res.json(getScheduleState());
  } catch {
    res.status(400).json({ error: "Generate tests before enabling scheduled execution." });
  }
});

await loadRunHistory();

app.listen(port, () => {
  console.log(`\nVeriFlow running -> http://localhost:${port}\n`);
  console.log("Routes registered: azure-stories, generate-tests, run-tests, generated-code, run-history, schedule");
});

