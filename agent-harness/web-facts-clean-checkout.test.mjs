import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("web-facts prepares runtime exports in a clean workspace before running Web tests", () => {
  const fixture = mkdtempSync(join(tmpdir(), "web-facts-clean-"));
  const copy = (path) => {
    const target = join(fixture, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target, { recursive: true });
  };
  const link = (source, target) => {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(source), target, "junction");
  };
  try {
    for (const path of ["tsconfig.base.json", "pnpm-workspace.yaml", "packages/shared-types/package.json",
      "packages/shared-types/tsconfig.json", "packages/shared-types/src", "apps/web/package.json",
      "apps/web/src/model-catalog-health.ts", "apps/web/src/model-catalog-health.test.ts"]) copy(path);
    link(join(root, "packages/shared-types/node_modules"), join(fixture, "packages/shared-types/node_modules"));
    // Reuse installed third-party tools offline, but resolve workspace imports to
    // the fixture so an existing checkout's dist cannot hide the missing build.
    const webModules = join(root, "apps/web/node_modules");
    for (const name of readdirSync(webModules)) {
      if (name !== "@deepsonar" && name !== ".bin") link(join(webModules, name), join(fixture, "apps/web/node_modules", name));
    }
    // pnpm's generated shim adds the source checkout to NODE_PATH. Invoke the
    // real CLI instead, so missing fixture exports cannot fall back to that tree.
    mkdirSync(join(fixture, "apps/web/node_modules/.bin"));
    symlinkSync(realpathSync(join(webModules, "tsx/dist/cli.mjs")), join(fixture, "apps/web/node_modules/.bin/tsx"), "file");
    link(join(fixture, "packages/shared-types"), join(fixture, "apps/web/node_modules/@deepsonar/shared-types"));

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const script = pkg.scripts["ci:unit:web-facts"];
    assert.ok(script.includes("src/model-catalog-health.test.ts"), "keep the affected test in web-facts");
    // Keep the real suite's setup and runner; focus its test list on the existing
    // consumer that needs shared-types values, rather than a mock package export.
    const focused = script.replace(/(?<=tsx --test ).*$/, "src/model-catalog-health.test.ts");
    assert.notEqual(focused, script, "expected the web-facts tsx test runner");
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ private: true, packageManager: pkg.packageManager,
      scripts: { "ci:unit:web-facts": focused } }));
    const output = join(fixture, "packages/shared-types/dist/index.js");
    assert.equal(existsSync(output), false, "fixture must start without generated runtime exports");
    const env = { ...process.env, NODE_PATH: "" };
    // This is an independent test-runner process, not a node:test child worker.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync("pnpm ci:unit:web-facts", { cwd: fixture, shell: true, encoding: "utf8", timeout: 120_000,
      env });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /legacy string catalog becomes stale descriptors/, "the real consumer tests must execute");
    assert.equal(existsSync(output), true, "web-facts must build the shared runtime entry");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
