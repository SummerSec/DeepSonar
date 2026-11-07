import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { hasChromeArm64Gate } from "./ci-chrome-arm64-gate.mjs";
import { GATE_SHARDS, GATE_SHARD_RESULT_VARS } from "./gate-shards.mjs";

const { parse, stringify } = createRequire(new URL("../apps/scheduler/package.json", import.meta.url))("yaml");
const root = new URL("../", import.meta.url);
const source = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
const workflow = parse(source);
const jobs = workflow.jobs;
const classify = jobs.changes.steps.find((step) => step.id === "classify").run;
const summary = jobs["ci-summary"].steps.find((step) => step.name === "Verify required results").run;
const heavy = ["windows-upgrade-backend", "crash-recovery", "lexical-pressure", "pi-om-growth", ...GATE_SHARDS, "runtime-images", "chrome-fuzz-arm64-build", "chrome-fuzz-arm64"];
const resultVars = ["WINDOWS", "CRASH", "LEXICAL", "PIOM", ...Object.values(GATE_SHARD_RESULT_VARS), "IMAGES", "FUZZ_BUILD", "FUZZ"];
const runSummary = (overrides = {}) => spawnSync("bash", ["-c", summary], {
  env: { ...process.env, CHANGES: "success", DOCS: "success", DOCS_ONLY: "false", MODE: "ready-full", PLAN_STATUS: "ok",
    // #961: the ARM pair is judged by the plan, so the default fixture must answer it.
    FUZZ_ARM_REQUIRED: "required",
    ...Object.fromEntries(resultVars.map((name) => [name, "success"])), ...overrides }, encoding: "utf8",
});

test("actual classifier handles docs, runtime inputs, unknowns, rename/delete and dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-routing-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.email", "ci@example.invalid"); git("config", "user.name", "CI fixture");
    writeFileSync(join(dir, "README.md"), "initial\n");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "CHANGELOG.md"), "initial\n");
    writeFileSync(join(dir, "docs/PI_RPC_PAYLOAD_LIMITS.md"), "initial\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(dir, "agent-harness"), { recursive: true });
    writeFileSync(join(dir, "agent-harness/classify-ci-changes.mjs"), readFileSync(new URL("agent-harness/classify-ci-changes.mjs", root)));
    const classifyHead = (event = "pull_request", head = git("rev-parse", "HEAD")) => {
      const output = join(dir, "output"); writeFileSync(output, "");
      const run = spawnSync("bash", ["-c", classify], { cwd: dir, encoding: "utf8",
        env: { ...process.env, EVENT_NAME: event, PR_BASE: base, PR_HEAD: head, GITHUB_OUTPUT: output } });
      const invalidRevision = event === "pull_request" && (!head || head === "missing-ref");
      assert.equal(run.status, invalidRevision ? 1 : 0, run.stderr);
      return readFileSync(output, "utf8").trim().split("\n").find(line => line.startsWith("docs_only="));
    };
    assert.equal(classifyHead(), "docs_only=false", "empty diff");
    for (const [files, expected] of [
      [["README.md"], true], [["docs/README.md"], true], [["docs/architecture/README.md"], true],
      [["CHANGELOG.md", "docs/PI_RPC_PAYLOAD_LIMITS.md"], true],
      [["CHANGELOG.md", "docs/PI_RPC_PAYLOAD_LIMITS.md", "skills/audit/SKILL.md"], false],
      [["docs/guide.md"], false], [["docs/architecture/new.md"], false], [["docs/说明 文档.md"], false],
      [["docs/README.md "], false],
      [["LICENSE"], true], [["README.md", "apps/new.ts"], false],
      [["agent-harness/runtime-manuals/tools/binutils.md"], false],
      [["agent-harness/runtime-manuals/other.md"], false], [["agent-harness/other.md"], false],
      [["skills/example/SKILL.md"], false], [["docs/evidence/result.md"], false],
      [["docs/data.json"], false], [["unknown.md"], false], [[".github/workflows/ci.yml"], false],
    ]) {
      git("reset", "--hard", base);
      for (const file of files) {
        mkdirSync(join(dir, file, ".."), { recursive: true });
        writeFileSync(join(dir, file), "changed\n");
      }
      git("add", "--", ...files); git("commit", "-qm", "fixture");
      assert.equal(classifyHead(), `docs_only=${expected}`, files.join(","));
      assert.equal(classifyHead("workflow_dispatch"), "docs_only=false");
      assert.equal(classifyHead("push"), "docs_only=false");
    }
    git("reset", "--hard", base); git("rm", "README.md"); git("commit", "-qm", "delete");
    assert.equal(classifyHead(), "docs_only=false");
    git("reset", "--hard", base); git("mv", "README.md", "DESIGN.md"); git("commit", "-qm", "rename");
    assert.equal(classifyHead(), "docs_only=false");
    assert.equal(classifyHead("pull_request", "missing-ref"), "docs_only=false", "git failure is full");
    assert.equal(classifyHead("pull_request", ""), "docs_only=false", "missing input is full");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actual summary rejects failures, cancellation, missing outputs and unexpected skips", () => {
  assert.equal(runSummary().status, 0);
  const docs = { MODE: "docs", DOCS_ONLY: "true", FUZZ_ARM_REQUIRED: "skipped", ...Object.fromEntries(resultVars.map((name) => [name, "skipped"])) };
  assert.equal(runSummary(docs).status, 0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    for (const name of ["CHANGES", "DOCS", ...resultVars]) {
      assert.notEqual(runSummary({ [name]: result }).status, 0, `${name}: ${result}`);
      if (name === "CHANGES" || name === "DOCS" || result !== "skipped") {
        assert.notEqual(runSummary({ ...docs, [name]: result }).status, 0);
      }
    }
  }
  for (const DOCS_ONLY of ["", "unknown"]) assert.notEqual(runSummary({ DOCS_ONLY }).status, 0);
  for (const name of resultVars) assert.notEqual(runSummary({ ...docs, [name]: "success" }).status, 0);
  // #836 tier assertions: a Draft runs never report a merge verdict, and a
  // failed run plan cannot be summarised as success.
  for (const MODE of ["draft-fast", "", "unknown"]) assert.notEqual(runSummary({ MODE }).status, 0, `MODE=${MODE}`);
  assert.notEqual(runSummary({ PLAN_STATUS: "failed" }).status, 0);
  assert.notEqual(runSummary({ PLAN_STATUS: "" }).status, 0);
  assert.notEqual(runSummary({ ...docs, DOCS_ONLY: "false" }).status, 0, "docs tier must report docs_only=true");

  // #961: the ARM pair is judged by the run plan instead of always being required.
  const armSkipped = { FUZZ_ARM_REQUIRED: "skipped", FUZZ_BUILD: "skipped", FUZZ: "skipped" };
  assert.equal(runSummary(armSkipped).status, 0, "plan-authorized skip must pass");
  for (const FUZZ_ARM_REQUIRED of ["", "unknown", "required "]) {
    assert.notEqual(runSummary({ FUZZ_ARM_REQUIRED }).status, 0, `chrome_fuzz_arm=${JSON.stringify(FUZZ_ARM_REQUIRED)}`);
  }
  assert.notEqual(runSummary({ FUZZ_ARM_REQUIRED: "required", FUZZ_BUILD: "skipped" }).status, 0, "required but skipped");
  assert.notEqual(runSummary({ ...armSkipped, FUZZ_BUILD: "success" }).status, 0, "planned skip must not silently run");
  for (const result of ["failure", "cancelled"]) {
    assert.notEqual(runSummary({ ...armSkipped, FUZZ: result }).status, 0, `planned skip with ${result}`);
  }
});

test("workflow really runs docs and regressions and preserves full-run dependencies", () => {
  // #972/#992: 分片变化不能豁免 file-size 门禁。
  const fileSizeShard = GATE_SHARDS
    .map((name) => jobs[name])
    .find((job) => job && job.steps.some((s) => s.name === "File size ratchet guard"));
  assert.ok(fileSizeShard, "File size ratchet guard 必须落在某个 gate 分片");
  const fileSizeStep = fileSizeShard.steps.find((s) => s.name === "File size ratchet guard");
  assert.equal(fileSizeStep.run, "pnpm ci:unit:file-size");
  assert.equal(fileSizeStep.if, undefined);
  assert.equal(fileSizeStep["continue-on-error"], undefined);
  const docs = jobs["docs-freshness"];
  assert.equal(docs.if, undefined);
  assert.equal(docs.steps.find((s) => s.uses === "actions/checkout@v4").with["fetch-depth"], 0);
  for (const command of ["pnpm install --frozen-lockfile", "pnpm ci:unit:docs-freshness", "pnpm ci:unit:ci-routing"]) {
    assert.ok(docs.steps.some((s) => s.run === command && !s.if && !s["continue-on-error"]), command);
  }
  assert.equal(jobs["ci-summary"].if, "always() && needs.changes.outputs.mode != 'draft-fast'");
  assert.ok(jobs["draft-fast"], "the Draft fast tier must exist");
  assert.ok(jobs["ci-preview"], "Draft runs need a non-required preview check");
  assert.equal(jobs["ci-preview"].if, "always() && needs.changes.outputs.mode == 'draft-fast'");
  assert.equal(jobs["draft-fast"].if, "always() && !cancelled() && needs.changes.outputs.mode == 'draft-fast'");
  // Draft fast checks reuse the frozen install and never start heavy services.
  for (const command of ["pnpm install --frozen-lockfile", "pnpm -r typecheck", "pnpm -r build"]) {
    assert.ok(jobs["draft-fast"].steps.some((s) => s.run === command), command);
  }
  // Suites import workspace packages via their built dist; without build the fast
  // path fails with ERR_MODULE_NOT_FOUND (observed on the #836 sample PR).
  assert.ok(jobs["draft-fast"].steps.findIndex((s) => s.run === "pnpm -r build")
    < jobs["draft-fast"].steps.findIndex((s) => s.name === "Mapped no-service unit suites"),
    "build must run before the mapped suites");
  assert.equal(jobs["draft-fast"].services, undefined, "Draft fast tier must not start PostgreSQL");
  assert.deepEqual(workflow.on.pull_request.types, ["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft"]);
  assert.ok(jobs.changes.steps.some((s) => s.id === "plan" && s.run.includes("ci-run-plan.mjs")));
  for (const output of ["mode", "plan_status", "required_suites", "fast_suites", "reasons"]) {
    assert.ok(jobs.changes.outputs[output], `changes job must expose ${output}`);
  }
  assert.deepEqual(new Set(jobs["ci-summary"].needs), new Set(["changes", "docs-freshness", ...heavy]));
  for (const name of heavy) {
    assert.ok([jobs[name].needs].flat().includes("changes"));
    assert.ok(jobs[name].if.startsWith("always() && !cancelled() && needs.changes.outputs.mode == 'ready-full'"));
  }
  assert.ok(jobs["chrome-fuzz-arm64"].if.includes("needs.chrome-fuzz-arm64-build.result == 'success'"));
});

test("#972/#992 gate 的五个有界分片：if 一致且 contract/runtime 无服务", () => {
  const shards = GATE_SHARDS;
  for (const name of shards) {
    assert.ok(jobs[name], `分片 ${name} 必须存在`);
    assert.ok(
      jobs[name].if.startsWith("always() && !cancelled() && needs.changes.outputs.mode == 'ready-full'"),
      `${name} 的 if 必须以 ready-full 门禁开头`,
    );
  }
  assert.equal(jobs["gate-contract"].services, undefined, "gate-contract 不声明 services.postgres");
  assert.equal(jobs["gate-runtime"].services, undefined, "gate-runtime 不声明 services.postgres");
});

test("ARM64 guard normalizes scalar/array needs and retains all original safeguards", () => {
  assert.equal(hasChromeArm64Gate(source), true);
  for (const needs of ["chrome-fuzz-arm64-build", ["changes", "chrome-fuzz-arm64-build"]]) {
    const copy = structuredClone(workflow); copy.jobs["chrome-fuzz-arm64"].needs = needs;
    assert.equal(hasChromeArm64Gate(stringify(copy)), true);
  }
  for (const needs of [undefined, "changes", ["changes"], []]) {
    const copy = structuredClone(workflow); copy.jobs["chrome-fuzz-arm64"].needs = needs;
    assert.equal(hasChromeArm64Gate(stringify(copy)), false);
  }
  for (const marker of ["chrome-fuzz-arm64-build:", "chrome-fuzz-arm64:", "runs-on: ubuntu-24.04-arm",
    "steps.image.outputs.digest", "docker/setup-qemu-action@v3", "platforms: linux/arm64",
    'docker pull --platform linux/arm64 "$image_ref"', "test-chrome-runtime.mjs",
    "agent-harness/chrome-fuzz-runtime.json linux/arm64"]) {
    assert.equal(hasChromeArm64Gate(source.replaceAll(marker, marker.endsWith(":") ? "removed-marker:" : marker.includes(": ") ? `${marker.split(": ")[0]}: removed-marker` : "removed-marker")), false, marker);
  }
});

test("docs-only runs the real freshness gate: good links pass, broken links fail summary", () => {
  const fixture = new URL(`docs/ci-routing-fixture-${process.pid}.md`, root);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Child must start its own test runner, not inherit this worker.
  const runDocs = () => spawnSync("pnpm", ["ci:unit:docs-freshness"], { cwd: root, env, encoding: "utf8" });
  const docsResults = { DOCS_ONLY: "true", FUZZ_ARM_REQUIRED: "skipped", ...Object.fromEntries(resultVars.map((name) => [name, "skipped"])) };
  try {
    writeFileSync(fixture, "[README](../README.md)\n[Wrapped README](<../README.md>)\n");
    const good = runDocs();
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.equal(runSummary(docsResults).status, 0);
    for (const target of ["./ci-routing-missing-target.md", "<./ci-routing-missing-target.md>"]) {
      writeFileSync(fixture, `[Broken](${target})\n`);
      const bad = runDocs();
      assert.notEqual(bad.status, 0, "broken link must fail real docs gate");
      assert.match(bad.stdout + bad.stderr, /ci-routing-missing-target/);
      assert.notEqual(runSummary({ ...docsResults, DOCS: "failure" }).status, 0);
    }
  } finally { rmSync(fixture, { force: true }); }
});
