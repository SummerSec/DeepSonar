import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scheduler = new URL("../../../", import.meta.url);
const scripts = JSON.parse(readFileSync(new URL("package.json", scheduler), "utf8")).scripts as Record<string, string>;
const graph = {
  contract: ["quality-contract", "qualityDigest"], metrics: ["quality-metrics", "computeQualityMetrics"],
  identity: ["identity", "digestIdentityValue"], identity_sources: ["identity-source-store", "sourceContentDigest"],
  identity_mappings: ["identity-mapping-store", "loadCurrentIdentitySnapshot"],
  selector: ["strong-candidate-selector", "selectStrongRelationCandidates"],
  assets: ["quality-assets", "bootFindingQualityAssets"], store: ["quality-store", "qualityVersion"],
  ledger: ["quality-ledger", "validateQualityReceiptChain"], state: ["quality-state-store", "withQualityHead"],
  worker: ["quality-worker", "processFindingQualityWork"], api: ["quality-api", "findingQualityEvidenceStatus"],
  relation_read: ["relation-read", "readStrongRelationPage"],
  relation_computation: ["relation-computation", "processStrongRelationBatch"],
} as const;
const basis = "node_sync_load_returned_source_under_trusted_preload";
const modes = [
  { name: "development", directory: "src", extension: "ts", script: "dev", omit: 2,
    expected: "node --import tsx --import ./src/domains/project-finding-research/quality-source-bootstrap.ts --watch src/index.ts" },
  { name: "production", directory: "dist", extension: "js", script: "start", omit: 1,
    expected: "node --import ./dist/domains/project-finding-research/quality-source-bootstrap.js dist/index.js" },
] as const;
type Mode = typeof modes[number];
type Scenario = "preloaded" | "missing" | "late-prerequisite" | "cached-graph";

function runGraph(mode: Mode, scenario: Scenario): Record<string, unknown> {
  assert.equal(scripts[mode.script], mode.expected, "actual package entrypoint and preload order");
  const flags = scripts[mode.script]!.split(/\s+/u).slice(1, -mode.omit);
  const bootstrap = flags.at(-1)!;
  const loaderOnly = mode.directory === "src" ? flags.slice(0, 2) : [];
  const root = new URL(`${mode.directory}/domains/project-finding-research/`, scheduler).href;
  const body = `
    import assert from "node:assert/strict";
    import net from "node:net";
    import { syncBuiltinESMExports } from "node:module";
    const forbid = () => { throw new Error("ENTRYPOINT_NETWORK_OR_SERVER_FORBIDDEN"); };
    net.Socket.prototype.connect = forbid;
    net.Server.prototype.listen = forbid;
    globalThis.fetch = forbid;
    syncBuiltinESMExports();
    const graph = ${JSON.stringify(graph)}, root = ${JSON.stringify(root)}, extension = ${JSON.stringify(mode.extension)};
    const scenario = ${JSON.stringify(scenario)};
    const url = name => new URL(name + "." + extension, root).href;
    const loadGraph = async () => Object.fromEntries(await Promise.all(
      Object.entries(graph).map(async ([key, [name]]) => [key, await import(url(name))])));
    let cached;
    if (scenario === "late-prerequisite") {
      cached = await import(url("quality-contract"));
      await import(${JSON.stringify(bootstrap)});
      assert.strictEqual(await import(url("quality-contract")), cached);
    }
    if (scenario === "cached-graph") {
      cached = await loadGraph();
      await import(${JSON.stringify(bootstrap)});
    }
    const modules = await loadGraph();
    if (cached && scenario === "cached-graph") {
      for (const key of Object.keys(graph)) assert.strictEqual(modules[key], cached[key]);
    }
    for (const [key, [, exported]] of Object.entries(graph)) {
      assert.equal(typeof modules[key][exported], "function", key + " evaluated its actual exports");
    }
    if (scenario !== "preloaded") {
      const code = scenario === "missing" ? "QUALITY_SOURCE_CAPTURE_NOT_INSTALLED" : "QUALITY_SOURCE_CAPTURE_UNOBSERVED";
      assert.throws(() => modules.assets.bootFindingQualityAssets(), { code });
      assert.throws(() => modules.assets.requireFindingQualityAssets(), { code: "QUALITY_ASSETS_NOT_BOOTSTRAPPED" });
      console.log(JSON.stringify({ scenario, code, modules: Object.keys(modules) }));
    } else {
      const assets = modules.assets.bootFindingQualityAssets();
      assert.strictEqual(modules.assets.bootFindingQualityAssets(), assets);
      assert.strictEqual(modules.assets.requireFindingQualityAssets(), assets);
      assert.equal(assets.integrity_basis, ${JSON.stringify(basis)});
      assert.deepEqual(Object.keys(assets.module_digests).sort(), Object.keys(graph).sort());
      assert.equal(Object.keys(assets.module_digests).length, 14);
      assert.ok(Object.isFrozen(assets));
      assert.ok(Object.isFrozen(assets.module_digests));
      const capture = await import(url("quality-source-capture")), observed = {};
      for (const [key, [name]] of Object.entries(graph)) {
        const receipt = capture.requireCapturedFindingQualitySource(url(name));
        assert.equal(receipt.module_url, url(name));
        assert.equal(receipt.integrity_basis, assets.integrity_basis);
        assert.match(receipt.source_digest, /^sha256:[a-f0-9]{64}$/u);
        assert.equal(assets.module_digests[key], receipt.source_digest);
        assert.ok(receipt.source_byte_length > 0);
        assert.ok(["module", "module-typescript"].includes(receipt.source_format));
        if (extension === "js") assert.equal(receipt.source_format, "module");
        observed[key] = receipt;
      }
      const { contract: c, identity: i, identity_sources: s, identity_mappings: m, selector: q } = modules;
      const actualConfig = {
        identity_fields: [...i.PLATFORM_IDENTITY_FIELDS], strong_classes: [...c.QUALITY_STRONG_CLASSES],
        identity_authority_basis: s.IDENTITY_SOURCE_AUTHORITY_BASIS, independent_external_verification: false,
        node_version: process.versions.node, source_integrity_basis: assets.integrity_basis,
        source_limit: c.QUALITY_SOURCE_LIMIT, label_limit: c.QUALITY_LABEL_LIMIT,
        trace_limit: c.QUALITY_TRACE_LIMIT, decision_limit: c.QUALITY_DECISION_LIMIT,
        input_bytes: c.QUALITY_INPUT_BYTES, pair_limit: q.RELATION_PAIR_LIMIT,
        identity_mapping_history_limit: m.IDENTITY_MAPPING_HISTORY_LIMIT,
        extractor_version: i.STRONG_IDENTITY_EXTRACTOR_VERSION,
        normalization_version: i.STRONG_IDENTITY_NORMALIZATION_VERSION,
        strong_rule_version: i.STRONG_RELATION_RULE_VERSION, metric_version: c.QUALITY_METRIC_VERSION,
        population_version: c.QUALITY_POPULATION_VERSION, label_mapping_version: c.QUALITY_LABEL_MAPPING_VERSION,
      };
      assert.equal(assets.config_digest, c.qualityDigest(actualConfig), "bind Node version and exported configuration");
      assert.notEqual(assets.config_digest, c.qualityDigest({ ...actualConfig, node_version: "unobserved-node" }));
      assert.match(c.qualityDigest({ entrypoint: "module-evaluation-only" }), /^sha256:[a-f0-9]{64}$/u);
      assert.match(i.digestIdentityValue("entrypoint"), /^sha256:[a-f0-9]{64}$/u);
      assert.equal(modules.store.qualityVersion("1"), "1");
      assert.equal(modules.api.findingQualityEvidenceStatus().quality_status, "not_evaluated");
      console.log(JSON.stringify({ scenario, node_version: process.versions.node,
        integrity_basis: assets.integrity_basis, code_digest: assets.code_digest,
        config_digest: assets.config_digest, module_digests: assets.module_digests, observed }));
    }
  `;
  const result = spawnSync(process.execPath,
    [...(scenario === "preloaded" ? flags : loaderOnly), "--input-type=module", "--eval", body], {
      cwd: fileURLToPath(scheduler), encoding: "utf8", timeout: 20_000, maxBuffer: 128 * 1024,
      // Only this child: no inherited preload, on-disk TSX cache or live .env loading.
      env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", DEEPSONAR_OFFLINE_PREFLIGHT: "1" },
    });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "bounded graph imports must not emit service output");
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

// Actual package graphs only; adversarial leaf-loader cases are covered separately.
// Compiled assets are REQUIRED: missing dist fails instead of silently skipping.
for (const mode of modes) {
  test(`${mode.name} package preload captures the actual 14-module graph before asset boot`, () => {
    const result = runGraph(mode, "preloaded");
    assert.equal(result.node_version, process.versions.node);
    assert.equal(result.integrity_basis, basis);
    assert.equal(Object.keys(result.module_digests as object).length, 14);
  });
  for (const scenario of ["missing", "late-prerequisite", "cached-graph"] as const) {
    test(`${mode.name} actual graph fails closed for ${scenario}`, () => {
      const result = runGraph(mode, scenario);
      assert.equal(result.scenario, scenario);
      assert.equal((result.modules as unknown[]).length, 14);
    });
  }
}
