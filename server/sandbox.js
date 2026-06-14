import { spawn, execFile } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Resolve the Playwright version VeriFlow is pinned to so the Docker sandbox
// pulls the matching official image (browser binaries are baked into the tag).
async function detectPlaywrightVersion() {
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const pkg = require("@playwright/test/package.json");
    if (pkg?.version) return pkg.version;
  } catch {
    /* fall through */
  }
  return null;
}

// `docker info` only succeeds when the daemon is actually reachable, which is
// stricter (and more honest) than checking the CLI exists.
async function dockerAvailable() {
  try {
    await execFileAsync("docker", ["info"], { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// The sandbox env is deliberately minimal: NONE of VeriFlow's secrets
// (ANTHROPIC_API_KEY, AZURE_DEVOPS_PAT, etc.) are passed to the test process or
// container. Generated/LLM-authored code never sees them.
function hardenedEnv() {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || process.env.USERPROFILE || "",
    CI: "1",
  };
  // Let the test config resolve @playwright/test from VeriFlow's own install
  // even when the run cwd is a scratch dir without its own node_modules.
  if (process.env.NODE_PATH) env.NODE_PATH = process.env.NODE_PATH;
  return env;
}

function decideMode(requested, hasDocker) {
  if (requested === "process") return "process";
  if (requested === "docker") return "docker";
  // Default ("auto"): prefer docker when the daemon is up, else process.
  return hasDocker ? "docker" : "process";
}

// Run a command with a stripped env and NO shell (argv passed directly, so
// generated test titles/paths can never be interpreted by a shell).
function runProcess(command, args, { cwd, timeout }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env: hardenedEnv(),
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      stderr += `\nSandbox timed out after ${timeout}ms; killing test process.`;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + (err.message || String(err)), code: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

// Resolve the Playwright CLI entry (cli.js) from this install. We invoke it via
// `node <cli.js> test` rather than `npx`/`.cmd`, which avoids a shell entirely
// (no `.cmd` spawn quirks on Windows, no shell-injection surface) and works
// cross-platform.
async function resolvePlaywrightCli() {
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  return require.resolve("@playwright/test/cli");
}

// Hardened child_process fallback: runs the local Playwright CLI directly with
// no shell and a stripped env. Playwright exits non-zero on failures/no-tests,
// which is fine — the caller decides the outcome from results.json.
async function runInProcess({ cwd, timeout }) {
  const cli = await resolvePlaywrightCli();
  const res = await runProcess(process.execPath, [cli, "test"], { cwd, timeout });
  return { ...res, mode: "process" };
}

// Docker sandbox: runs the generated suite inside the official Playwright image
// (browsers preinstalled, matching tag). Only the project dir is mounted, the
// container env carries no secrets, and outbound network is restricted to the
// bridge (no host network, no extra capabilities). results.json is written back
// to the mounted volume so the caller parses it exactly as before.
async function runInDocker({ cwd, timeout, version, network }) {
  const tag = version ? `v${version}` : "latest";
  const image = `mcr.microsoft.com/playwright:${tag}-jammy`;
  const args = [
    "run",
    "--rm",
    "--init",
    // Secret isolation: a container does NOT inherit the host's environment, so
    // none of VeriFlow's secrets reach it. We pass only CI=1 explicitly. (The
    // old `--env-file /dev/null` was both redundant and invalid on Windows.)
    "-e",
    "CI=1",
    // Drop privileges/capabilities; read-only-ish, restricted network.
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    network,
    // Mount the project so generated.spec.js, playwright.config.js and the
    // results.json output path are all visible to the container.
    "-v",
    `${cwd}:/work`,
    "-w",
    "/work",
    image,
    "npx",
    "playwright",
    "test",
  ];
  const res = await runProcess("docker", args, { cwd, timeout });
  // A non-zero exit with no results.json means Docker itself failed (bad mount,
  // image pull denied, daemon quirk) rather than tests failing — surface it as
  // an error so the caller falls back to the hardened process runner.
  const producedResults = existsSync(path.join(cwd, "generated", "results.json"));
  if (res.code !== 0 && !producedResults) {
    throw new Error(`docker run produced no results.json (exit ${res.code}): ${res.stderr.trim()}`);
  }
  return { ...res, mode: "docker" };
}

/**
 * Run the generated Playwright suite in an isolated sandbox.
 *
 * Mode is controlled by VERIFLOW_SANDBOX = docker | process (default: auto —
 * docker if the daemon is reachable, else the hardened process fallback).
 * VERIFLOW_DOCKER_NETWORK overrides the container network (default "none";
 * set to "bridge" if the target site is on the public internet).
 *
 * Returns { stdout, stderr, mode } where mode reports what actually ran. The
 * suite always writes generated/results.json into `cwd`, so callers parse it
 * the same way regardless of sandbox mode.
 */
export async function runSandboxedTests({ cwd, timeout = 60000 } = {}) {
  const requested = (process.env.VERIFLOW_SANDBOX || "auto").toLowerCase();
  const network = process.env.VERIFLOW_DOCKER_NETWORK || "none";

  let hasDocker = false;
  if (requested !== "process") hasDocker = await dockerAvailable();

  const mode = decideMode(requested, hasDocker);

  if (mode === "docker" && hasDocker) {
    const version = await detectPlaywrightVersion();
    try {
      return await runInDocker({ cwd, timeout, version, network });
    } catch (err) {
      // If Docker invocation itself blows up (image pull denied, etc.), fall
      // back to the hardened process runner rather than failing the run.
      const fallback = await runInProcess({ cwd, timeout });
      fallback.stderr =
        `[sandbox] docker run failed (${err.message || err}); fell back to process.\n` +
        fallback.stderr;
      return fallback;
    }
  }

  if (requested === "docker" && !hasDocker) {
    const fallback = await runInProcess({ cwd, timeout });
    fallback.stderr =
      "[sandbox] VERIFLOW_SANDBOX=docker requested but Docker daemon is unreachable; " +
      "fell back to hardened process execution.\n" +
      fallback.stderr;
    return fallback;
  }

  return runInProcess({ cwd, timeout });
}

export const __test = { decideMode, hardenedEnv };
