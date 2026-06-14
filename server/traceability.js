import fs from "fs/promises";

// Split a multi-line acceptance-criteria blob into individual criteria lines,
// stripping common bullet/numbering prefixes.
function splitCriteria(criteria) {
  if (!criteria) return [];
  return String(criteria)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

// Lightweight token overlap so each criterion is mapped to the generated
// test(s) whose names share the most meaningful words. Keeps traceability
// deterministic and dependency-free (no model call needed).
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "to", "of", "and", "or", "in", "on", "for",
  "with", "that", "this", "can", "user", "verify", "should", "be", "page",
  "test", "tc001", "tc002", "tc003", "tc004", "tc005",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function overlapScore(aTokens, bTokens) {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const bSet = new Set(bTokens);
  let hits = 0;
  for (const t of aTokens) if (bSet.has(t)) hits += 1;
  return hits / aTokens.length;
}

/**
 * Build a requirement -> test traceability matrix.
 *
 * Maps each acceptance criterion to the generated test(s) that best cover it
 * (by name-token overlap) and folds in each test's pass/fail outcome from the
 * run report. Always includes an explicit list of every test and its status so
 * uncovered/extra tests are still visible.
 *
 * @returns the matrix object (also persisted to `outPath`).
 */
export async function buildTraceabilityMatrix({ context, report, outPath }) {
  const tests = report?.tests || [];
  const criteria = splitCriteria(context?.criteria);

  const testTokens = tests.map((t) => ({ test: t, tokens: tokenize(t.name) }));

  const rows = criteria.map((criterion, index) => {
    const cTokens = tokenize(criterion);
    const scored = testTokens
      .map(({ test, tokens }) => ({ test, score: overlapScore(cTokens, tokens) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const matched = (scored.length ? scored : []).map(({ test }) => ({
      name: test.name,
      status: test.status,
      duration: test.duration,
    }));

    const statuses = matched.map((m) => m.status);
    let coverage;
    if (matched.length === 0) coverage = "uncovered";
    else if (statuses.includes("failed")) coverage = "failing";
    else if (statuses.every((s) => s === "passed")) coverage = "passing";
    else coverage = "partial";

    return {
      id: `AC${String(index + 1).padStart(2, "0")}`,
      criterion,
      coverage,
      tests: matched,
    };
  });

  const matrix = {
    generatedAt: new Date().toISOString(),
    story: context?.story || "",
    url: context?.url || "",
    requirementsTotal: rows.length,
    requirementsCovered: rows.filter((r) => r.coverage !== "uncovered").length,
    requirementsPassing: rows.filter((r) => r.coverage === "passing").length,
    rows,
    tests: tests.map((t) => ({ name: t.name, status: t.status, duration: t.duration })),
  };

  if (outPath) {
    await fs.writeFile(outPath, JSON.stringify(matrix, null, 2), "utf8").catch(() => {});
  }
  return matrix;
}
