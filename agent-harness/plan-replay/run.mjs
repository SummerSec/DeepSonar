import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildReplayReport } from "./report.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../..");
const destination = resolve(root, "artifacts/plan-replay/report.json");
await rm(destination, { force: true });
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required; skipped DB tests cannot satisfy current-v2 replay");

const baselineBytes = await readFile(resolve(scriptDir, "baseline-v2.json"), "utf8");
const work = await mkdtemp(resolve(tmpdir(), "plan-replay-v2-"));
const output = resolve(work, "observations.jsonl");
await writeFile(output, "", { mode: 0o600 });
const testFile = resolve(root, "apps/scheduler/src/plan-replay-v2.integration.test.ts");
const node = process.execPath;
const tsx = resolve(root, "apps/scheduler/node_modules/tsx/dist/cli.mjs");
const started = performance.now();
let run;
try {
  run = spawnSync(node, [tsx, "--test", "--test-concurrency=1", testFile], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_MODE: "fake",
      PLAN_REPLAY_OUTPUT: output,
    },
    stdio: "inherit",
    timeout: 180_000,
    encoding: "utf8",
  });
  let rows = [];
  try {
    rows = (await readFile(output, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    rows = [];
    console.error(`Unable to read current-v2 observation stream: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const metadata = rows.find((row) => row?.kind === "meta");
  const exitCode = typeof run?.status === "number" ? run.status : 1;
  const report = buildReplayReport(baselineBytes, rows, {
    commit: git.status === 0 ? git.stdout.trim() : null,
    dirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
    exit_code: exitCode,
    signal: run?.signal ?? null,
    elapsed_ms: Math.round(performance.now() - started),
    elapsed_scope: "entire isolated PostgreSQL/blob fixture including setup and teardown; not model time",
    fixture_completed: metadata?.fixture_completed === true,
    real_sql_http: metadata?.real_sql_http === true,
    database_isolated: metadata?.database_isolated === true,
    fault: process.env.PLAN_REPLAY_FAULT ?? null,
    launcher: { node: node.replaceAll("\\", "/"), tsx: "apps/scheduler/node_modules/tsx/dist/cli.mjs", test_file: "apps/scheduler/src/plan-replay-v2.integration.test.ts" },
  });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ report: destination, passed: report.passed, denominator: report.denominator, fault: report.provenance.fault }));
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
