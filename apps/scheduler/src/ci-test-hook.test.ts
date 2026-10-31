import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MANIFEST_RELATIVE,
  MANIFEST_SCHEMA,
  classifyTestHooks,
  evaluateGate,
  isTestReferenced,
  loadManifest,
  referenceFormsForTest,
  repoRootFromModuleUrl,
  runRepoGate,
  updateManifestRatchet,
  type CiTestHookManifest,
} from "./ci-test-hook-gate.js";

const ROOT = repoRootFromModuleUrl();
const MANIFEST_PATH = path.join(ROOT, MANIFEST_RELATIVE);

function manifest(partial?: Partial<CiTestHookManifest>): CiTestHookManifest {
  return {
    schema: MANIFEST_SCHEMA,
    allowlist: [],
    ...partial,
  };
}

test("repo ci-test-hook gate passes against the committed allowlist", () => {
  const result = runRepoGate(ROOT, MANIFEST_PATH);
  const errors = result.findings.filter((f) => f.kind === "error");
  assert.deepEqual(
    errors,
    [],
    errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
  );
  const doc = loadManifest(MANIFEST_PATH);
  for (const rel of doc.allowlist) {
    assert.ok(result.unhooked.includes(rel) || result.hooked.includes(rel), `missing ${rel}`);
  }
});

test("T1: new unhooked test not on allowlist fails", () => {
  const result = evaluateGate({
    manifest: manifest({ allowlist: [] }),
    previous: null,
    tests: ["apps/scheduler/src/brand-new.test.ts"],
    corpus: "pnpm exec tsx --test src/other.test.ts",
  });
  assert.ok(
    result.findings.some(
      (f) => f.kind === "error" && f.path === "apps/scheduler/src/brand-new.test.ts" && /unallowlisted|not referenced/.test(f.message),
    ),
  );
});

test("T2: allowlisted unhooked test is tolerated", () => {
  const result = evaluateGate({
    manifest: manifest({ allowlist: ["apps/scheduler/src/legacy.test.ts"] }),
    previous: null,
    tests: ["apps/scheduler/src/legacy.test.ts"],
    corpus: "pnpm exec tsx --test src/other.test.ts",
  });
  assert.equal(result.findings.filter((f) => f.kind === "error").length, 0);
  assert.deepEqual(result.unhooked, ["apps/scheduler/src/legacy.test.ts"]);
});

test("T3: allowlist growth vs previous fails", () => {
  const previous = manifest({ allowlist: ["apps/scheduler/src/a.test.ts"] });
  const current = manifest({
    allowlist: ["apps/scheduler/src/a.test.ts", "apps/scheduler/src/b.test.ts"],
  });
  const result = evaluateGate({
    manifest: current,
    previous,
    tests: ["apps/scheduler/src/a.test.ts", "apps/scheduler/src/b.test.ts"],
    corpus: "",
  });
  assert.ok(
    result.findings.some(
      (f) => f.kind === "error" && f.path === "apps/scheduler/src/b.test.ts" && /allowlist grew/.test(f.message),
    ),
  );
});

test("T4: --update shrinks allowlist for hooked/missing and rejects growth", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "deepsonar-ci-test-hook-"));
  try {
    // Minimal fake git repo so listTrackedTestFiles works.
    mkdirSync(path.join(temp, ".git"));
    const hookedRel = "apps/scheduler/src/now-hooked.test.ts";
    const stillRel = "apps/scheduler/src/still-unhooked.test.ts";
    const goneRel = "apps/scheduler/src/gone.test.ts";
    for (const rel of [hookedRel, stillRel]) {
      const abs = path.join(temp, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "import test from 'node:test';\ntest('x', () => {});\n", "utf8");
    }
    writeFileSync(
      path.join(temp, "package.json"),
      JSON.stringify({
        scripts: {
          "ci:unit:demo": `pnpm exec tsx --test ${hookedRel}`,
        },
      }),
      "utf8",
    );
    // git ls-files needs an index — seed via git init + add
    execFileSync("git", ["init"], { cwd: temp, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: temp, stdio: "ignore" });
    // ensure name for commit-less ls-files: ls-files works after add
    const manifestFile = path.join(temp, "manifest.json");
    writeFileSync(
      manifestFile,
      JSON.stringify(
        manifest({
          allowlist: [hookedRel, stillRel, goneRel],
        }),
        null,
        2,
      ),
      "utf8",
    );

    const updated = updateManifestRatchet(temp, manifestFile);
    assert.ok(updated.removed.some((line) => line.startsWith(`${hookedRel}:`)));
    assert.ok(updated.removed.some((line) => line.startsWith(`${goneRel}:`)));
    assert.deepEqual(updated.kept, [stillRel]);
    const after = JSON.parse(readFileSync(manifestFile, "utf8")) as CiTestHookManifest;
    assert.deepEqual(after.allowlist, [stillRel]);
    // Fresh unhooked not previously allowlisted must not be added.
    assert.ok(updated.rejected.length === 0 || updated.rejected.every((line) => !line.includes(stillRel)));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("T5: reference forms cover package-relative and cross-package paths", () => {
  const forms = referenceFormsForTest("apps/scheduler/src/skill-pull.test.ts");
  assert.ok(forms.includes("apps/scheduler/src/skill-pull.test.ts"));
  assert.ok(forms.includes("src/skill-pull.test.ts"));
  assert.equal(
    isTestReferenced("apps/web/src/model-catalog-health.test.ts", "tsx --test src/model-catalog-health.test.ts"),
    true,
  );
  assert.equal(
    isTestReferenced("apps/scheduler/src/skill-pull.test.ts", "tsx --test src/other.test.ts"),
    false,
  );
  const classified = classifyTestHooks({
    tests: ["apps/scheduler/src/a.test.ts", "apps/scheduler/src/b.test.ts"],
    corpus: "src/a.test.ts",
  });
  assert.deepEqual(classified.hooked, ["apps/scheduler/src/a.test.ts"]);
  assert.deepEqual(classified.unhooked, ["apps/scheduler/src/b.test.ts"]);
});
