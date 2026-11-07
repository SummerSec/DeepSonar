import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setSharedAssetBlobStoreForTests, sharedAssetBlobUri, type BlobStore } from "./blob-store/index.js";
import { approveSkillSourceCandidate, contentHashOf, syncSkillSource, type SourceModule } from "./skill-sources.js";
import { freezeJobSkillCatalog, loadJobSkillCatalog, persistSkillSourceManifest, pullFrozenJobSkill } from "./job-skill-catalog.js";
import { healthySkillSourceRevision, stageSkillSourceCandidate, type SkillSourceCandidate, type SkillSourceState } from "./skill-source-catalog-lifecycle.js";
import { withKnowledgeDatabase, type TestSql } from "./domains/project-knowledge/test-support.js";

const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 };
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
function module(body: string): SourceModule {
  return { id: "stable-id", kind: "skill", plugin: "(root)", name: "fixture", description: "fixture",
    files: { "SKILL.md": `---\nname: fixture\ndescription: fixture\n---\n${body}` } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function isolated(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const bytes = new Map<string, Buffer>();
  const store: BlobStore = { kind: "fs", put: async (key, value) => { bytes.set(key, Buffer.from(value)); },
    get: async key => { const value = bytes.get(key); if (!value) throw new Error("missing"); return Buffer.from(value); },
    exists: async key => bytes.has(key), materializeLocal: async () => { throw new Error("unused"); } };
  setSharedAssetBlobStoreForTests(store);
  try { await withKnowledgeDatabase(async db => { await run(await fixture(db, bytes)); }); }
  finally { setSharedAssetBlobStoreForTests(null); }
}
async function fixture(db: TestSql, bytes: Map<string, Buffer>) {
  // Keep the baseline's built-in source outside this fixture's inventory.
  await db`UPDATE skill_sources SET enabled=false,trust_status='disabled'`;
  const id = randomUUID(), projectId = randomUUID(), roleId = randomUUID(), agentRoleId = randomUUID();
  await db`INSERT INTO projects(id,name) VALUES(${projectId},${`fixture-${projectId}`})`;
  const hashA = await persistSkillSourceManifest(db as never, { sourceId: id, commitSha: A, catalog: [module("A")] });
  await db`INSERT INTO skill_sources(id,name,repo_url,branch,enabled,trust_status,catalog_json,catalog_snapshot_hash,last_commit_sha,last_content_hash,synced_at)
    VALUES(${id},${`fixture-${id}`},'https://127.0.0.1/skills.git','main',true,'trusted',${db.json([module("A")] as never)},
      ${hashA},${A},${contentHashOf([module("A")])},'2026-11-06T00:00:00Z')`;
  await db`INSERT INTO agent_roles(id,name) VALUES(${agentRoleId},${`fixture-${agentRoleId}`})`;
  await db`INSERT INTO role_configs(id,role_id,modules_json) VALUES(${roleId},${agentRoleId},${db.json([`${id}:stable-id`, `${id}:removed`] as never)})`;
  const [{ name }] = await db`SELECT current_database() AS name`;
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${name}`;
  const state = async () => (await db`SELECT * FROM skill_sources WHERE id=${id}`)[0] as SkillSourceState;
  const git = (commit: string, body: string, clone?: () => Promise<void>) => async (_file: string, args: string[]) => {
    if (args[0] === "clone") {
      await clone?.();
      const root = path.join(args.at(-1)!, "stable-id");
      await mkdir(root, { recursive: true }); await writeFile(path.join(root, "SKILL.md"), module(body).files["SKILL.md"]!);
      return { stdout: "" };
    }
    assert.equal(args.at(-1), "HEAD"); return { stdout: commit };
  };
  const sync = (commit = B, body = "B", clone?: () => Promise<void>, signal?: AbortSignal, skipIfUnchanged = false) =>
    syncSkillSource(id, "fixture", signal, { db: db as never, databaseUrl: url.toString(), execFile: git(commit, body, clone),
      skipIfUnchanged, probeHead: async () => commit });
  const initialInstanceId = (await state()).source_instance_id;
  const approve = (candidateHash: string, expectedEpoch = "0", expectedSourceInstanceId = initialInstanceId) => approveSkillSourceCandidate({
    sourceId: id, candidateHash, expectedEpoch, expectedSourceInstanceId, actorId: "fixture", enabled: true }, db as never);
  return { db, id, projectId, roleId, bytes, hashA, state, sync, approve };
}

test("A publication survives sync B; approval alone changes new Job inventory and heals RoleConfig", options, async () => {
  await isolated(async f => {
    const before = await f.state();
    const oldJob = await freezeJobSkillCatalog(f.db as never, f.projectId);
    const result = await f.sync();
    assert.equal(result.selector_cleanup.role_configs_updated, 0);
    const staged = await f.state();
    for (const key of ["catalog_json", "catalog_snapshot_hash", "last_commit_sha", "last_content_hash", "synced_at", "enabled", "trust_status", "revocation_epoch"] as const) {
      assert.deepEqual(staged[key as keyof SkillSourceState], before[key as keyof SkillSourceState], key);
    }
    const [role] = await f.db`SELECT modules_json FROM role_configs WHERE id=${f.roleId}`;
    assert.deepEqual(role.modules_json, [`${f.id}:stable-id`, `${f.id}:removed`]);
    const during = await freezeJobSkillCatalog(f.db as never, f.projectId);
    assert.equal(during.sources[0]!.manifest_hash, f.hashA);
    const loadedA = await loadJobSkillCatalog(f.db as never, f.projectId, oldJob);
    const pullA = pullFrozenJobSkill(oldJob, loadedA, `${f.id}:stable-id`, contentHashOf([module("A")]));
    assert.equal(pullA.ok && pullA.skill.files["SKILL.md"], module("A").files["SKILL.md"]);
    const candidate = staged.candidate_json as SkillSourceCandidate;
    assert.deepEqual(Object.keys(candidate).sort(), ["schema", "source_instance_id", "repo_url", "branch", "revocation_epoch", "commit_sha", "content_hash", "module_count", "synced_at", "synced_by"].sort());
    await f.approve(result.candidate_hash!);
    const published = await f.state();
    assert.equal(published.candidate_hash, null);
    const [time] = await f.db`SELECT synced_at FROM skill_sources WHERE id=${f.id}`;
    assert.equal(new Date(time.synced_at).toISOString(), candidate.synced_at);
    const newJob = await freezeJobSkillCatalog(f.db as never, f.projectId);
    assert.equal(newJob.sources[0]!.manifest_hash, result.candidate_hash);
    assert.equal(newJob.sources[0]!.commit_sha, B);
    assert.equal((await loadJobSkillCatalog(f.db as never, f.projectId, oldJob))[0]!.catalog[0]!.files["SKILL.md"], module("A").files["SKILL.md"]);
    assert.deepEqual((await f.db`SELECT modules_json FROM role_configs WHERE id=${f.roleId}`)[0].modules_json, [`${f.id}:stable-id`]);
    const audits = await f.db`SELECT after_json FROM audit_logs WHERE action='skill_source.catalog_diff' AND resource_id=${f.id}`;
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].after_json.added_module_ids, []);
    assert.deepEqual(audits[0].after_json.removed_module_ids, []);
    assert.notEqual(audits[0].after_json.previous_content_hash, audits[0].after_json.content_hash);
  });
});

test("approval rejects stale hash/epoch, foreign CAS and changed descriptor without changing live", options, async () => {
  await isolated(async f => {
    const b = await f.sync(); await f.sync(C, "C");
    await assert.rejects(f.approve(b.candidate_hash!), /CONFLICT/);
    const source = await f.state();
    await assert.rejects(f.approve(source.candidate_hash!, "1"), /CONFLICT/);
    const c = source.candidate_json as SkillSourceCandidate;
    for (const changed of [{ branch: "other" }, { repo_url: "https://127.0.0.1/other.git" },
      { source_instance_id: randomUUID() }, { revocation_epoch: "1" }]) {
      await f.db`UPDATE skill_sources SET candidate_json=${f.db.json({ ...c, ...changed } as never)} WHERE id=${f.id}`;
      await assert.rejects(f.approve(source.candidate_hash!), /CONFLICT/);
    }
    const foreign = await persistSkillSourceManifest(f.db as never, { sourceId: randomUUID(), commitSha: C, catalog: [module("C")] });
    await f.db`UPDATE skill_sources SET candidate_json=${f.db.json(c as never)},candidate_hash=${foreign} WHERE id=${f.id}`;
    await assert.rejects(f.approve(foreign), /MANIFEST_INVALID/);
    assert.equal((await f.state()).catalog_snapshot_hash, f.hashA);
  });
});

test("an old instance approval cannot approve a recreated same-ID/hash/epoch candidate", options, async () => {
  await isolated(async f => {
    const old = await f.state();
    const staged = await f.sync();
    await f.db`DELETE FROM skill_sources WHERE id=${f.id}`;
    await f.db`INSERT INTO skill_sources(id,name,repo_url,branch)
      VALUES(${f.id},${old.name},${old.repo_url},${old.branch})`;
    const restaged = await f.sync();
    const current = await f.state();
    assert.notEqual(current.source_instance_id, old.source_instance_id);
    assert.equal(String(current.revocation_epoch), String(old.revocation_epoch));
    assert.equal(restaged.candidate_hash, staged.candidate_hash, "CAS bytes bind source ID, not source instance");
    // The helper defaults to the exact instance observed by the original caller.
    await assert.rejects(f.approve(staged.candidate_hash!, String(old.revocation_epoch)), /CONFLICT/);
    assert.equal((await f.state()).catalog_snapshot_hash, null);
    assert.equal((await f.state()).trust_status, "quarantined");
    assert.equal((await f.state()).candidate_hash, restaged.candidate_hash);
    await f.approve(restaged.candidate_hash!, String(current.revocation_epoch), current.source_instance_id);
    assert.equal((await f.state()).catalog_snapshot_hash, restaged.candidate_hash);
  });
});

test("publication and RoleConfig healing roll back if the transactional audit cannot persist", options, async () => {
  await isolated(async f => {
    const staged = await f.sync();
    await f.db.unsafe(`CREATE FUNCTION fixture_reject_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'skill_source.candidate_approved' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_reject_approval_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fixture_reject_approval_audit()`);
    await assert.rejects(f.approve(staged.candidate_hash!), /fixture audit failure/);
    assert.equal((await f.state()).catalog_snapshot_hash, f.hashA);
    assert.equal((await f.state()).candidate_hash, staged.candidate_hash);
    assert.deepEqual((await f.db`SELECT modules_json FROM role_configs WHERE id=${f.roleId}`)[0].modules_json,
      [`${f.id}:stable-id`, `${f.id}:removed`]);
    assert.equal((await f.db`SELECT count(*)::int AS n FROM audit_logs WHERE action='skill_source.catalog_diff' AND resource_id=${f.id}`)[0].n, 0);
  });
});

test("disable/revoke and configuration changes are not blocked by clone and fence late staging", options, async () => {
  await isolated(async f => {
    for (const change of ["disabled", "epoch", "branch", "repo"] as const) {
      // New fixture identity per iteration would be cleaner, but restoring enabled
      // never restores epoch; the assertion intentionally captures the current one.
      await f.db`UPDATE skill_sources SET trust_status='trusted',enabled=true,branch='main',repo_url='https://127.0.0.1/skills.git' WHERE id=${f.id}`;
      const started = deferred(), release = deferred();
      const running = f.sync(B, "B", async () => { started.resolve(); await release.promise; });
      await started.promise;
      if (change === "disabled") await f.db`UPDATE skill_sources SET trust_status='disabled',enabled=false WHERE id=${f.id}`;
      if (change === "epoch") await f.db`UPDATE skill_sources SET enabled=false WHERE id=${f.id}`;
      if (change === "branch") await f.db`UPDATE skill_sources SET branch='other' WHERE id=${f.id}`;
      if (change === "repo") await f.db`UPDATE skill_sources SET repo_url='https://127.0.0.1/other.git' WHERE id=${f.id}`;
      release.resolve(); await assert.rejects(running, /source_changed|source_disabled/);
      assert.equal((await f.state()).catalog_snapshot_hash, f.hashA);
      assert.equal((await f.state()).candidate_hash, null);
    }
  });
});

test("a failed clone records only a bounded safe code and never refreshes live age", options, async () => {
  await isolated(async f => {
    const before = (await f.db`SELECT synced_at FROM skill_sources WHERE id=${f.id}`)[0].synced_at;
    await assert.rejects(f.sync(B, "B", async () => { throw new Error("fatal https://user:secret@127.0.0.1/repo?token=secret"); }), /^Error: sync_failed$/);
    const [after] = await f.db`SELECT last_sync_error,last_checked_at,synced_at,candidate_hash FROM skill_sources WHERE id=${f.id}`;
    assert.equal(after.last_sync_error, "sync_failed"); assert.ok(after.last_checked_at);
    assert.equal(new Date(after.synced_at).toISOString(), new Date(before).toISOString());
    assert.equal(after.candidate_hash, null);
  });
});

test("a deleted/recreated source cannot receive the previous instance's in-flight clone", options, async () => {
  await isolated(async f => {
    const started = deferred(), release = deferred();
    const original = await f.state();
    const running = f.sync(B, "B", async () => { started.resolve(); await release.promise; });
    await started.promise;
    try {
      await f.db`DELETE FROM skill_sources WHERE id=${f.id}`;
      await f.db`INSERT INTO skill_sources(id,name,repo_url,branch,enabled,trust_status)
        VALUES(${f.id},${original.name},${original.repo_url},${original.branch},true,'trusted')`;
    } finally { release.resolve(); }
    await assert.rejects(running, /source_changed/);
    const current = await f.state();
    assert.notEqual(current.source_instance_id, original.source_instance_id);
    assert.equal(current.candidate_hash, null); assert.equal(current.catalog_snapshot_hash, null);
  });
});

test("revoked source needs a new epoch-bound candidate even when restored bytes equal old live", options, async () => {
  await isolated(async f => {
    const oldJob = await freezeJobSkillCatalog(f.db as never, f.projectId);
    await f.db`UPDATE skill_sources SET trust_status='disabled',enabled=false WHERE id=${f.id}`;
    await f.db`UPDATE skill_sources SET trust_status='quarantined' WHERE id=${f.id}`;
    const restored = await f.sync(A, "A", undefined, undefined, true);
    assert.equal(restored.candidate_hash, f.hashA, "inactive live bytes must not bypass reapproval");
    assert.equal((await f.state()).enabled, false);
    await assert.rejects(f.approve(f.hashA, "0"), /CONFLICT/);
    await f.approve(f.hashA, "1");
    assert.equal((await f.state()).enabled, true);
    assert.deepEqual(await loadJobSkillCatalog(f.db as never, f.projectId, oldJob), []);
    assert.equal((await freezeJobSkillCatalog(f.db as never, f.projectId)).sources[0]!.source_revocation_epoch, "1");
  });
});

test("two real sync service calls serialize clone through staging across dedicated sessions", options, async () => {
  await isolated(async f => {
    const firstStarted = deferred(), releaseFirst = deferred();
    let secondCloned = false;
    const first = f.sync(B, "B", async () => { firstStarted.resolve(); await releaseFirst.promise; });
    await firstStarted.promise;
    const second = f.sync(C, "C", async () => { secondCloned = true; });
    // Establish that the second session is actually waiting in PostgreSQL,
    // rather than concluding from a timer that it probably has not cloned.
    let waiting = false;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const [row] = await f.db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='deepsonar-skill-source-sync'
            AND wait_event_type='Lock' AND wait_event='advisory') AS waiting`;
        if (row.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, "second sync must actually wait on the shared advisory key");
      assert.equal(secondCloned, false);
    } finally { releaseFirst.resolve(); }
    const [b, c] = await Promise.all([first, second]);
    assert.equal((await f.state()).candidate_hash, c.candidate_hash);
    assert.notEqual(b.candidate_hash, c.candidate_hash);
    assert.equal((await f.state()).catalog_snapshot_hash, f.hashA);
  });
});

test("cancellation after stage UPDATE rolls back the candidate and publication fields", options, async () => {
  await isolated(async f => {
    const staged = await f.sync();
    const captured = await f.state();
    const controller = new AbortController(); let checks = 0;
    await assert.rejects(stageSkillSourceCandidate({ captured, hash: staged.candidate_hash!,
      candidate: { ...(captured.candidate_json as SkillSourceCandidate), synced_by: "must-rollback" }, signal: controller.signal,
      assertLock: async () => { if (++checks === 2) controller.abort(); } }, f.db as never), /CANCELLED/);
    assert.deepEqual((await f.state()).candidate_json, captured.candidate_json);
    assert.equal((await f.state()).catalog_snapshot_hash, f.hashA);
  });
});

test("only a healthy exact-live check advances live freshness; pending B checks do not refresh A", options, async () => {
  await isolated(async f => {
    let cloned = false;
    const before = (await f.db`SELECT synced_at FROM skill_sources WHERE id=${f.id}`)[0].synced_at;
    const live = await f.sync(A, "A", async () => { cloned = true; }, undefined, true);
    assert.equal(live.skipped, true); assert.equal(live.candidate_hash, null); assert.equal(cloned, false);
    const checkedA = (await f.db`SELECT synced_at FROM skill_sources WHERE id=${f.id}`)[0].synced_at;
    assert.ok(new Date(checkedA).getTime() > new Date(before).getTime());
    await f.sync();
    const pending = await f.sync(B, "B", async () => { cloned = true; }, undefined, true);
    assert.equal(pending.skipped, true); assert.equal(cloned, false);
    assert.equal(new Date((await f.db`SELECT synced_at FROM skill_sources WHERE id=${f.id}`)[0].synced_at).toISOString(), new Date(checkedA).toISOString());
  });
});

test("missing/corrupt CAS and wrong manifest identity/count cannot produce healthy unchanged", options, async () => {
  await isolated(async f => {
    const source = await f.state();
    assert.ok(await healthySkillSourceRevision(source, A, f.db as never));
    assert.equal(await healthySkillSourceRevision({ ...source, catalog_snapshot_hash: null }, A, f.db as never), null);
    f.bytes.delete(sharedAssetBlobUri(f.hashA));
    assert.equal(await healthySkillSourceRevision(source, A, f.db as never), null);
    const restored = await f.sync(A, "A", undefined, undefined, true);
    assert.equal(restored.skipped, false);
    assert.equal(restored.candidate_hash, null);
    assert.equal((await f.state()).catalog_snapshot_hash, f.hashA);
    f.bytes.set(sharedAssetBlobUri(f.hashA), Buffer.from("bad"));
    assert.equal(await healthySkillSourceRevision(source, A, f.db as never), null);
    // Different body at the same SHA cannot rebind old approved A. It is a candidate.
    const changed = await f.sync(A, "different", undefined, undefined, true);
    assert.equal(changed.skipped, false);
    assert.notEqual(changed.candidate_hash, f.hashA);
    assert.equal((await f.state()).catalog_snapshot_hash, f.hashA);
    const valid = await persistSkillSourceManifest(f.db as never, { sourceId: f.id, commitSha: A, catalog: [module("A")] });
    assert.equal(await healthySkillSourceRevision({ ...source, catalog_snapshot_hash: valid, catalog_json: [] }, A, f.db as never), null);
    assert.equal(await healthySkillSourceRevision({ ...source, id: randomUUID(), catalog_snapshot_hash: valid }, A, f.db as never), null);
  });
});
