import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MANIFEST_RELATIVE,
  MANIFEST_SCHEMA,
  classifyPath,
  countLines,
  evaluateGate,
  hardLimitFor,
  isExcludedPath,
  loadManifest,
  looksGenerated,
  repoRootFromModuleUrl,
  runRepoGate,
  updateManifestRatchet,
  type FileSizeManifest,
} from "./file-size-gate.js";

const ROOT = repoRootFromModuleUrl();
const MANIFEST_PATH = path.join(ROOT, MANIFEST_RELATIVE);

const BASE_LIMITS = {
  logicSoft: 1200,
  logicHard: 2000,
  webComponentSoft: 800,
  contractHard: 6000,
};

function linesOf(n: number): string {
  return `${"x\n".repeat(n)}`;
}

function manifest(partial?: Partial<FileSizeManifest>): FileSizeManifest {
  return {
    schema: MANIFEST_SCHEMA,
    limits: { ...BASE_LIMITS },
    contractPaths: ["database/schema.sql"],
    grandfathered: {},
    ...partial,
  };
}

test("repo file-size gate passes against the committed ratchet manifest", () => {
  const result = runRepoGate(ROOT, MANIFEST_PATH);
  const errors = result.findings.filter((f) => f.kind === "error");
  assert.deepEqual(
    errors,
    [],
    errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
  );
  const manifestDoc = loadManifest(MANIFEST_PATH);
  for (const [rel, entry] of Object.entries(manifestDoc.grandfathered)) {
    assert.ok(rel in result.measured, `missing measurement for ${rel}`);
    assert.ok(result.measured[rel] <= entry.maxLines, `${rel} grew past maxLines`);
  }
});

test("T1: ungrandfathered file over logic hard limit fails", () => {
  const result = evaluateGate({
    manifest: manifest(),
    previous: null,
    files: ["apps/scheduler/src/huge.ts"],
    contentsByPath: { "apps/scheduler/src/huge.ts": linesOf(2100) },
  });
  assert.ok(result.findings.some((f) => f.kind === "error" && f.path === "apps/scheduler/src/huge.ts"));
});

test("T2: grandfathered file growth past maxLines fails", () => {
  const result = evaluateGate({
    manifest: manifest({
      grandfathered: {
        "apps/scheduler/src/core.ts": { class: "logic", maxLines: 100, issue: "#544" },
      },
    }),
    previous: null,
    files: ["apps/scheduler/src/core.ts"],
    contentsByPath: { "apps/scheduler/src/core.ts": linesOf(101) },
  });
  assert.ok(
    result.findings.some(
      (f) => f.kind === "error" && f.path === "apps/scheduler/src/core.ts" && /split the file/.test(f.message),
    ),
  );
});

test("T3: raising grandfathered maxLines vs previous manifest fails", () => {
  const previous = manifest({
    grandfathered: {
      "apps/scheduler/src/core.ts": { class: "logic", maxLines: 100, issue: "#544" },
    },
  });
  const current = manifest({
    grandfathered: {
      "apps/scheduler/src/core.ts": { class: "logic", maxLines: 120, issue: "#544" },
    },
  });
  const result = evaluateGate({
    manifest: current,
    previous,
    files: ["apps/scheduler/src/core.ts"],
    contentsByPath: { "apps/scheduler/src/core.ts": linesOf(100) },
  });
  assert.ok(result.findings.some((f) => f.kind === "error" && /maxLines raised/.test(f.message)));
});

test("T4: logic soft..hard band warns without failing", () => {
  const result = evaluateGate({
    manifest: manifest(),
    previous: null,
    files: ["apps/scheduler/src/mid.ts", "database/schema.sql"],
    contentsByPath: {
      "apps/scheduler/src/mid.ts": linesOf(1500),
      "database/schema.sql": "-- schema\n",
    },
  });
  assert.equal(result.findings.filter((f) => f.kind === "error").length, 0);
  assert.ok(result.findings.some((f) => f.kind === "warn" && f.path === "apps/scheduler/src/mid.ts"));
});

test("T5: --update lowers maxLines on shrink and rejects raises", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "deepsonar-file-size-"));
  try {
    const rel = "apps/scheduler/src/sample.ts";
    const abs = path.join(temp, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, linesOf(80), "utf8");
    const manifestFile = path.join(temp, "manifest.json");
    writeFileSync(
      manifestFile,
      JSON.stringify(
        manifest({
          grandfathered: {
            [rel]: { class: "logic", maxLines: 100, issue: "#544" },
          },
        }),
        null,
        2,
      ),
      "utf8",
    );

    const lowered = updateManifestRatchet(temp, manifestFile);
    assert.deepEqual(lowered.rejected, []);
    assert.equal(lowered.changed.length, 1);
    const after = JSON.parse(readFileSync(manifestFile, "utf8")) as FileSizeManifest;
    assert.equal(after.grandfathered[rel].maxLines, 80);

    writeFileSync(abs, linesOf(90), "utf8");
    const rejected = updateManifestRatchet(temp, manifestFile);
    assert.ok(rejected.rejected.some((line) => /raising is not allowed/.test(line)));
    assert.equal(rejected.changed.length, 0);
    const unchanged = JSON.parse(readFileSync(manifestFile, "utf8")) as FileSizeManifest;
    assert.equal(unchanged.grandfathered[rel].maxLines, 80);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("T6: contract class without generated marker or contractPaths fails", () => {
  const result = evaluateGate({
    manifest: manifest({
      contractPaths: ["database/schema.sql"],
      grandfathered: {
        "apps/scheduler/src/core.ts": { class: "contract", maxLines: 50, issue: "#544" },
      },
    }),
    previous: null,
    files: ["apps/scheduler/src/core.ts", "database/schema.sql"],
    contentsByPath: {
      "apps/scheduler/src/core.ts": "export const x = 1;\n",
      "database/schema.sql": "-- schema\n",
    },
  });
  assert.ok(
    result.findings.some(
      (f) => f.kind === "error" && f.path === "apps/scheduler/src/core.ts" && /contract class requires/.test(f.message),
    ),
  );
});

test("T7: grandfathered entry missing issue fails", () => {
  const result = evaluateGate({
    manifest: manifest({
      grandfathered: {
        // @ts-expect-error intentional incomplete fixture
        "apps/scheduler/src/core.ts": { class: "logic", maxLines: 10 },
      },
    }),
    previous: null,
    files: ["apps/scheduler/src/core.ts"],
    contentsByPath: { "apps/scheduler/src/core.ts": linesOf(5) },
  });
  assert.ok(result.findings.some((f) => f.kind === "error" && /missing issue/.test(f.message)));
});

test("T8: excluded directories are filtered from path checks", () => {
  assert.equal(isExcludedPath("apps/scheduler/node_modules/pkg/index.js"), true);
  assert.equal(isExcludedPath("apps/web/dist/bundle.js"), true);
  assert.equal(isExcludedPath("packages/runtime-sandbox/build/out.js"), true);
  assert.equal(isExcludedPath("apps/scheduler/src/core.ts"), false);
});

test("helpers: classifyPath, hardLimitFor, countLines, looksGenerated", () => {
  assert.equal(classifyPath("apps/web/src/pages/X.tsx", []), "web");
  assert.equal(classifyPath("apps/web/src/api.ts", ["apps/web/src/api.ts"]), "contract");
  assert.equal(classifyPath("apps/scheduler/src/core.ts", []), "logic");
  assert.equal(hardLimitFor("web", BASE_LIMITS), 800);
  assert.equal(hardLimitFor("logic", BASE_LIMITS), 2000);
  assert.equal(hardLimitFor("contract", BASE_LIMITS), 6000);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines(""), 0);
  assert.equal(looksGenerated("/* DO NOT EDIT */\nexport {}\n"), true);
  assert.equal(looksGenerated("export const ok = true;\n"), false);
});
