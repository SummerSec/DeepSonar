import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "./blob-store/index.js";
import { contentHashOf, listAvailableSkillsFromCatalog, pullSkillFromCatalog, type SourceModule } from "./skill-sources.js";
import { encodeSkillSourceManifest, freezeJobSkillCatalog, loadJobSkillCatalog, pullFrozenJobSkill, JobSkillCatalogError } from "./job-skill-catalog.js";
import { sharedAssetBlobUri } from "./blob-store/index.js";
import { listHubSkillSourceCatalog } from "./domains/project-skill-allowlist/catalog.js";
import { handleCapabilityDiscovery } from "./domains/capability-pack/discovery.js";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const HIDDEN = "33333333-3333-4333-8333-333333333333";

function skill(name: string, body: string): SourceModule {
  return { id: name, kind: "skill", plugin: "(root)", name, description: name, files: { "SKILL.md": body } };
}

type Source = { source_instance_id: string; id: string; name: string; enabled: boolean; trust_status: string; last_commit_sha: string; last_content_hash: string; catalog_json: SourceModule[]; catalog_snapshot_hash: string | null; revocation_epoch: string };

function fixture() {
  const blobs = new Map<string, Buffer>();
  const store: BlobStore = {
    kind: "fs",
    put: async (key, bytes) => { blobs.set(key, Buffer.from(bytes)); },
    get: async (key) => { const value = blobs.get(key); if (!value) throw new Error("missing blob"); return Buffer.from(value); },
    exists: async (key) => blobs.has(key),
    materializeLocal: async () => { throw new Error("unused"); },
  };
  setSharedAssetBlobStoreForTests(store);
  const sources: Source[] = [
    { source_instance_id: A, id: A, name: "A", enabled: true, trust_status: "trusted", last_commit_sha: "v1", last_content_hash: "", catalog_json: [skill("alpha", "v1")], catalog_snapshot_hash: null, revocation_epoch: "0" },
    { source_instance_id: B, id: B, name: "B", enabled: true, trust_status: "trusted", last_commit_sha: "v1", last_content_hash: "", catalog_json: [skill("beta", "v1")], catalog_snapshot_hash: null, revocation_epoch: "0" },
    { source_instance_id: HIDDEN, id: HIDDEN, name: "Hidden", enabled: true, trust_status: "trusted", last_commit_sha: "v1", last_content_hash: "", catalog_json: [skill("hidden", "private")], catalog_snapshot_hash: null, revocation_epoch: "0" },
  ];
  for (const source of sources) {
    source.last_content_hash = contentHashOf(source.catalog_json);
    const bytes = encodeSkillSourceManifest({ sourceId: source.id, commitSha: source.last_commit_sha, catalog: source.catalog_json });
    const hash = createHash("sha256").update(bytes).digest("hex");
    source.catalog_snapshot_hash = hash;
    blobs.set(sharedAssetBlobUri(hash), bytes);
  }
  const bindings = new Map<string, { enabled: boolean; revocation_epoch: string }>([[HIDDEN, { enabled: false, revocation_epoch: "1" }]]);
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM skill_sources ss") && query.includes("ORDER BY")) {
      return sources.filter((source) => source.enabled && source.trust_status === "trusted" && bindings.get(source.id)?.enabled !== false)
        .map((source) => ({ ...source, module_count: source.catalog_json.length, project_revocation_epoch: bindings.get(source.id)?.revocation_epoch ?? "0" }));
    }
    if (query.includes("FROM skill_sources ss") && query.includes("WHERE ss.id =")) {
      const source = sources.find((item) => item.id === values[1]);
      if (!source) return [];
      return [{ ...source, project_revocation_epoch: bindings.get(source.id)?.revocation_epoch ?? "0", project_enabled: bindings.get(source.id)?.enabled ?? true }];
    }
    if (query.includes("INSERT INTO shared_asset_blobs")) return [];
    throw new Error(`unexpected query: ${query}`);
  }) as Parameters<typeof freezeJobSkillCatalog>[0];
  return { db, sources, bindings, blobs, store };
}

test("frozen catalog excludes hidden sources from total and pagination, and rejects cross scope", async () => {
  const { db } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    const loaded = await loadJobSkillCatalog(db, PROJECT, frozen);
    assert.deepEqual(loaded.map((source) => source.id), [A, B]);
    const page = listAvailableSkillsFromCatalog(loaded, { limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.next_offset, 1);
    assert.equal(listAvailableSkillsFromCatalog(loaded, { query: "hidden" }).total, 0);
    assert.equal(pullSkillFromCatalog(loaded, `${HIDDEN}:hidden`, "0".repeat(64)).ok, false);
    await assert.rejects(loadJobSkillCatalog(db, OTHER, frozen), (error) => error instanceof JobSkillCatalogError && error.error_code === "JOB_SKILL_SCOPE_MISMATCH");
    await assert.rejects(loadJobSkillCatalog(db, PROJECT, undefined), (error) => error instanceof JobSkillCatalogError && error.error_code === "JOB_SKILL_CATALOG_MISSING");
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("source revocation affects only that source and survives disable then enable", async () => {
  const { db, sources } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    sources[0]!.enabled = false;
    sources[0]!.revocation_epoch = "1";
    const unrevoked = await loadJobSkillCatalog(db, PROJECT, frozen);
    assert.deepEqual(unrevoked.map((source) => source.id), [B]);
    const denied = pullFrozenJobSkill(frozen, unrevoked, `${A}:alpha`, "0".repeat(64));
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error_code, "KNOWLEDGE_REVOKED");
    const unknown = pullFrozenJobSkill(frozen, unrevoked, `${OTHER}:alpha`, "0".repeat(64));
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error_code, "SKILL_NOT_FOUND");
    sources[0]!.enabled = true;
    assert.deepEqual((await loadJobSkillCatalog(db, PROJECT, frozen)).map((source) => source.id), [B]);
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("deleting and recreating the same source ID does not revive frozen Jobs", async () => {
  const { db, sources } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    sources[0]!.source_instance_id = OTHER;
    assert.deepEqual((await loadJobSkillCatalog(db, PROJECT, frozen)).map((source) => source.id), [B]);
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("later sync preserves old manifest bytes and CAS corruption fails closed", async () => {
  const { db, sources, blobs } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    sources[0]!.catalog_json = [skill("alpha", "v2")];
    sources[0]!.last_commit_sha = "v2";
    sources[0]!.catalog_snapshot_hash = null;
    const old = await loadJobSkillCatalog(db, PROJECT, frozen);
    const listed = listAvailableSkillsFromCatalog(old, { query: "alpha" });
    const pulled = pullSkillFromCatalog(old, listed.skills[0]!.selector, listed.skills[0]!.content_hash);
    assert.equal(pulled.ok && pulled.skill.files["SKILL.md"], "v1");
    const key = [...blobs.keys()][0]!;
    blobs.set(key, Buffer.from("tampered"));
    await assert.rejects(loadJobSkillCatalog(db, PROJECT, frozen), /hash|integrity/i);
    assert.notEqual(createHash("sha256").update(blobs.get(key)!).digest("hex"), frozen.sources[0]!.manifest_hash);
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("project disable and reenable cannot revive an older Job", async () => {
  const { db, bindings } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    bindings.set(A, { enabled: false, revocation_epoch: "1" });
    assert.deepEqual((await loadJobSkillCatalog(db, PROJECT, frozen)).map((source) => source.id), [B]);
    bindings.set(A, { enabled: true, revocation_epoch: "1" });
    assert.deepEqual((await loadJobSkillCatalog(db, PROJECT, frozen)).map((source) => source.id), [B]);
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("nonempty live catalog without synced CAS pointer fails Job creation", async () => {
  const { db, sources } = fixture();
  try {
    sources[0]!.catalog_snapshot_hash = null;
    await assert.rejects(freezeJobSkillCatalog(db, PROJECT), /snapshot missing|sync/i);
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("Hub summary and Capability discovery share the frozen revoked inventory", async () => {
  const { db, sources } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    sources[0]!.enabled = false;
    sources[0]!.revocation_epoch = "1";
    const summary = await listHubSkillSourceCatalog(db, PROJECT, frozen);
    assert.deepEqual(summary.map((item) => item.skill_source_id), [B]);
    const response = await handleCapabilityDiscovery({
      operation: "search_capabilities",
      payload: { query: "beta" },
      projectId: PROJECT,
      snapshot: { name: "audit", platform_tools: ["search_capabilities"], job_skill_catalog: frozen },
      db: db as never,
    });
    assert.equal(response.total, 1);
    const hidden = await handleCapabilityDiscovery({
      operation: "search_capabilities",
      payload: { query: "alpha" },
      projectId: PROJECT,
      snapshot: { name: "audit", platform_tools: ["search_capabilities"], job_skill_catalog: frozen },
      db: db as never,
    });
    assert.equal(hidden.total, 0);
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("revocation during CAS read is checked again before exposing files", async () => {
  const { db, sources, store } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    const originalGet = store.get.bind(store);
    store.get = async (key) => {
      if (key.endsWith(frozen.sources[0]!.manifest_hash!)) {
        sources[0]!.enabled = false;
        sources[0]!.revocation_epoch = "1";
      }
      return originalGet(key);
    };
    assert.deepEqual((await loadJobSkillCatalog(db, PROJECT, frozen)).map((source) => source.id), [B]);
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("revocation of an earlier source during a later source read is filtered", async () => {
  const { db, sources, store } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    const get = store.get.bind(store);
    store.get = async (key) => {
      if (key.endsWith(frozen.sources[1]!.manifest_hash!)) {
        sources[0]!.enabled = false;
        sources[0]!.revocation_epoch = "1";
      }
      return get(key);
    };
    assert.deepEqual((await loadJobSkillCatalog(db, PROJECT, frozen)).map((source) => source.id), [B]);
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("missing CAS bytes return a stable, sanitized catalog error", async () => {
  const { db, blobs } = fixture();
  try {
    const frozen = await freezeJobSkillCatalog(db, PROJECT);
    blobs.clear();
    await assert.rejects(loadJobSkillCatalog(db, PROJECT, frozen),
      (error) => error instanceof JobSkillCatalogError && error.error_code === "JOB_SKILL_CATALOG_INTEGRITY");
  } finally { setSharedAssetBlobStoreForTests(null); }
});
