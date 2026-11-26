import assert from "node:assert/strict";
import test from "node:test";
import { actorMayReadGovernanceSources, resolveSourceOwners } from "./source-scope.js";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const governanceJob = "22222222-2222-4222-8222-222222222222";
const ordinaryJob = "33333333-3333-4333-8333-333333333333";
const readerJob = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";

type Manifest = { input_ref: string; content_hash: string; audience: string[] }[];

/** 只覆盖 source-scope 会发出的查询；形状与生产 SQL 前缀一致。 */
function fakeDb(options: { governanceJobs?: string[]; manifest?: Manifest; stage?: string } = {}) {
  const governance = new Set(options.governanceJobs ?? []);
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("FROM artifact_evidence")) {
      const id = String(values[0]);
      if (id !== evidenceId) return Promise.resolve([]);
      return Promise.resolve([{ project_id: projectId, job_id: governance.has("evidence") ? governanceJob : ordinaryJob }]);
    }
    if (query.includes("FROM canvas_nodes")) return Promise.resolve([]);
    if (query.includes("FROM jobs WHERE id=")) return Promise.resolve([]);
    if (query.includes("SELECT 1 FROM project_knowledge_job_assignments")) {
      return Promise.resolve(governance.has(String(values[0])) ? [{ "?column?": 1 }] : []);
    }
    if (query.includes("SELECT stage, input_manifest_json")) {
      return Promise.resolve([{ stage: options.stage ?? "maker", input_manifest_json: options.manifest ?? [] }]);
    }
    return Promise.resolve([]);
  }) as never;
}

const source = { kind: "evidence", ref: evidenceId, content_hash: "a".repeat(64) };

test("普通来源不触发治理资料判定", async () => {
  const db = fakeDb();
  const resolved = await resolveSourceOwners(db, [source]);
  assert.equal(resolved.unresolved, 0);
  assert.equal(resolved.owners.length, 1);
  assert.equal(resolved.owners[0]!.governance, false);
  assert.equal(await actorMayReadGovernanceSources(db, { jobId: readerJob, projectId }, resolved.owners), true);
});

test("治理来源要求冻结清单逐字匹配且当前阶段在 audience 内", async () => {
  const manifest: Manifest = [{ input_ref: evidenceId, content_hash: "a".repeat(64), audience: ["maker"] }];
  const allowedDb = fakeDb({ governanceJobs: ["evidence", governanceJob], manifest, stage: "maker" });
  const resolved = await resolveSourceOwners(allowedDb, [source]);
  assert.equal(resolved.owners[0]!.governance, true);
  assert.equal(await actorMayReadGovernanceSources(allowedDb, { jobId: readerJob, projectId }, resolved.owners), true);

  const noRef = fakeDb({ governanceJobs: ["evidence", governanceJob], manifest: [], stage: "maker" });
  assert.equal(await actorMayReadGovernanceSources(noRef, { jobId: readerJob, projectId }, resolved.owners), false);

  const wrongStage = fakeDb({ governanceJobs: ["evidence", governanceJob], manifest, stage: "reviewer" });
  assert.equal(await actorMayReadGovernanceSources(wrongStage, { jobId: readerJob, projectId }, resolved.owners), false);

  const wrongHash = fakeDb({ governanceJobs: ["evidence", governanceJob], stage: "maker",
    manifest: [{ input_ref: evidenceId, content_hash: "b".repeat(64), audience: ["maker"] }] });
  assert.equal(await actorMayReadGovernanceSources(wrongHash, { jobId: readerJob, projectId }, resolved.owners), false);
});

test("来源不可用时明确计为 unresolved，未知 kind 不参与判定", async () => {
  const db = fakeDb();
  const gone = await resolveSourceOwners(db, [{ kind: "evidence", ref: "99999999-9999-4999-8999-999999999999" }]);
  assert.equal(gone.unresolved, 1, "定位不到的来源必须显式计数，不能当成「没有受限来源」");
  const unknown = await resolveSourceOwners(db, [{ kind: "feedback", ref: evidenceId }]);
  assert.equal(unknown.unresolved, 0, "没见过的来源形状不应导致知识被隐藏");
  assert.equal(unknown.owners.length, 0);
});
