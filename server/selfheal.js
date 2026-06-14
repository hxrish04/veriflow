import fs from "fs/promises";

// Heuristics for "this failure looks like a broken selector" — the only class
// of failure self-healing should touch. Assertion-logic failures, timeouts on
// navigation, etc. are intentionally left alone.
const SELECTOR_ERROR_HINTS = [
  "locator",
  "waiting for",
  "element is not visible",
  "no element matches",
  "resolved to 0 elements",
  "strict mode violation",
  "getByrole",
  "getbytext",
  "selector",
];

// Pull a flat list of failing specs (with their error text) out of the
// Playwright JSON report.
function collectFailures(jsonReport) {
  const failures = [];
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      if (spec.ok) continue;
      const errors = (spec.tests || [])
        .flatMap((t) => t.results || [])
        .flatMap((r) => r.errors || [])
        .map((e) => e.message || "")
        .filter(Boolean);
      const errorText = errors.join("\n");
      if (errorText) failures.push({ title: spec.title, errorText });
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of jsonReport?.suites || []) walk(suite);
  return failures;
}

function looksLikeSelectorFailure(errorText) {
  const lower = errorText.toLowerCase();
  return SELECTOR_ERROR_HINTS.some((hint) => lower.includes(hint));
}

// Extract the literal selector string Playwright reported as failing, e.g.
// `locator('input[name="missing"]')`. Returns the inner selector text or null.
function extractFailingSelector(errorText) {
  // Match the opening quote and capture everything up to the matching close
  // quote. The inner class only excludes the SAME quote char (via backref \1),
  // so selectors that embed the other quote type (e.g. input[name="x"] inside
  // single quotes) are captured intact.
  const patterns = [
    /locator\((['"`])((?:(?!\1).)+)\1\)/, // locator('css')
    /getByRole\((['"`])((?:(?!\1).)+)\1/, // getByRole('button'
    /getByText\((['"`])((?:(?!\1).)+)\1/, // getByText('foo'
    /getByTestId\((['"`])((?:(?!\1).)+)\1/,
  ];
  for (const re of patterns) {
    const m = errorText.match(re);
    if (m) return m[2];
  }
  return null;
}

// Capture the live DOM of the target page so Claude has real markup to repair
// the selector against. Uses the locally-installed Playwright chromium. Kept
// tightly bounded (single navigation, hard timeout) and best-effort.
async function captureDom(url) {
  if (!url) return null;
  let browser;
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const html = await page.content();
    // Cap the markup we send to the model.
    return html.slice(0, 12000);
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Ask Claude for a single replacement selector. Returns the new selector string
// or null. Bounded output, strict instructions, no markdown.
async function proposeSelector({ anthropic, oldSelector, errorText, dom, url }) {
  if (!anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 120,
      messages: [
        {
          role: "user",
          content: `A Playwright test failed because a selector no longer matches the page.
Target URL: ${url || "unknown"}
Failing selector string: ${oldSelector}
Error:
${errorText.slice(0, 800)}

Page HTML (truncated):
${dom || "(DOM unavailable)"}

Propose ONE replacement selector that targets the same intended element on this page.
Return ONLY the raw selector string (e.g. input[name="search"]), no quotes, no code fences, no explanation.
If you cannot determine a better selector, return the single word: NONE`,
        },
      ],
    });
    const text = message.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim()
      .replace(/^["'`]|["'`]$/g, "");
    if (!text || text.toUpperCase() === "NONE") return null;
    if (text === oldSelector) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Attempt to self-heal selector failures in the generated spec — bounded to a
 * single heal pass across the whole run (at most one rewrite per distinct
 * failing selector). Mutates the spec file on disk in place.
 *
 * @returns {{ healed: Array<{spec, oldSelector, newSelector}>, applied: boolean }}
 *   `applied` is true when at least one selector was rewritten and the caller
 *   should re-run the suite ONCE.
 */
export async function attemptHeal({ jsonReport, specPath, anthropic, url }) {
  const result = { healed: [], applied: false };
  if (!jsonReport) return result;

  const failures = collectFailures(jsonReport).filter((f) =>
    looksLikeSelectorFailure(f.errorText)
  );
  if (failures.length === 0) return result;

  let spec;
  try {
    spec = await fs.readFile(specPath, "utf8");
  } catch {
    return result;
  }

  const dom = await captureDom(url);
  const seen = new Set();
  let updated = spec;

  for (const failure of failures) {
    const oldSelector = extractFailingSelector(failure.errorText);
    if (!oldSelector || seen.has(oldSelector)) continue;
    seen.add(oldSelector);
    if (!updated.includes(oldSelector)) continue;

    const newSelector = await proposeSelector({
      anthropic,
      oldSelector,
      errorText: failure.errorText,
      dom,
      url,
    });
    if (!newSelector) continue;
    if (updated.includes(newSelector) && newSelector === oldSelector) continue;

    // Replace only the exact literal selector occurrences in the spec.
    updated = updated.split(oldSelector).join(newSelector);
    result.healed.push({ spec: failure.title, oldSelector, newSelector });
  }

  if (result.healed.length > 0 && updated !== spec) {
    await fs.writeFile(specPath, updated, "utf8");
    result.applied = true;
  }

  return result;
}
