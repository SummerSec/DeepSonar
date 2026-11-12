import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DSH_VERSION, DSH_PROFILE_MANIFEST, buildDshCordisSmokeConfig } from "./dsh-cordis-smoke-config.mjs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const lock = JSON.parse(read("./dsh-runtime/package-lock.json"));
const runtimePackage = JSON.parse(read("./dsh-runtime/package.json"));
assert.equal(runtimePackage.dependencies["@deepseek-ai/dsh"], DSH_VERSION);
assert.deepEqual(JSON.parse(DSH_PROFILE_MANIFEST).dsh.profile.bundles, []);
for (const [name, entry] of Object.entries(lock.packages)) {
  if (!/node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/u.test(name)) continue;
  assert.equal(entry.version, DSH_VERSION, `${name} must use the coherent official release`);
  assert.match(entry.integrity, /^sha512-/u, `${name} must carry registry integrity`);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//u);
}
for (const [manifestPath, dockerPath] of [["./runtime-images.json", "../deploy/Dockerfile.agent"], ["./kali-minimal-runtime.json", "../deploy/Dockerfile.agent-kali-minimal"]]) {
  const manifest = JSON.parse(read(manifestPath));
  const docker = read(dockerPath);
  assert.equal(manifest.npm["@deepseek-ai/dsh"].agent_cli, "dsh");
  assert.ok(!manifest.npm["dsh-reasoning-settings"], "obsolete UI settings interception must not be installed");
  for (const [name, entry] of Object.entries(manifest.npm)) {
    if (!name.startsWith("@deepseek-ai/dsh")) continue;
    const pinned = lock.packages[`node_modules/${name}`];
    assert.ok(pinned, `${name} missing from isolated runtime lockfile`);
    assert.equal(entry.version, DSH_VERSION);
    assert.equal(entry.integrity, pinned.integrity);
    assert.equal(entry.license, "MIT");
  }
  assert.ok(docker.includes(`ARG DSH_VERSION=${DSH_VERSION}`));
  assert.ok(docker.includes(`ARG DSH_INTEGRITY=${manifest.npm["@deepseek-ai/dsh"].integrity}`));
  assert.match(docker, /COPY agent-harness\/dsh-runtime\/package-lock\.json \/opt\/deepsonar\/dsh\/package-lock\.json/u);
  assert.match(docker, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/u);
  assert.ok(docker.includes('node /opt/deepsonar/dsh-request-budget-install.mjs /opt/deepsonar/dsh /opt/deepsonar/request-budget-source'),
    'governed provider artifact must be built into every DSH runtime image');
  assert.doesNotMatch(docker, /dsh-sdk-jsonrpc-demo|dsh-agent-spine-demo|dsh-reasoning-settings|DSH_CODE_RUNTIME/u);
}
for (const taskMode of ["standard", "ptc"]) {
  const rows = JSON.parse(buildDshCordisSmokeConfig({ taskMode }))[0].insert;
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  for (const row of rows) {
    assert.doesNotMatch(row.name, /dsh-(?:client|web|app-web|app-tui|tool-ask-user|credentials|authorization|settings|config-editor|plugin-manager|hmr|session-log-deepseek|session-telemetry|llm-deepseek)/u);
  }
  // 0.2.2-rc.1：`tools.mode` 已移除，执行器改为独立插件（native 或 ptc）按 scope 挂载。
  assert.equal(rows.find((row) => row.id === "tools").config, undefined);
  const executor = rows.find((row) => row.id === `${taskMode === "ptc" ? "ptc" : "native"}-tool-executor`);
  assert.equal(executor?.name, `@deepseek-ai/dsh-tool-executor-${taskMode === "ptc" ? "ptc" : "native"}`);
  assert.equal(rows.filter((row) => String(row.name ?? "").startsWith("@deepseek-ai/dsh-tool-executor-")).length, 1, "exactly one executor plugin");
  assert.equal(rows.some((row) => row.id === "ptc-runtime"), taskMode === "ptc");
  assert.deepEqual(rows.filter((row) => row.name.startsWith("@deepseek-ai/dsh-llm-")).map((row) => row.id).sort(), ["llm-pi-ai", "llm-retry"]);
  assert.equal(rows.find((row) => row.id === "skill-filesystem").config.includeDefaultRoots, false);
}
console.log(`DSH ${DSH_VERSION} coherent lockfile and governed SDK profile checks passed`);
