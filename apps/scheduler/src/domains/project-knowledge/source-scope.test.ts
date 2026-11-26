import assert from "node:assert/strict";
import test from "node:test";
import { actorMayReadGovernanceSources, resolveSourceOwners } from "./source-scope.js";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const factId = "66666666-6666-4666-8666-666666666666";
const governanceJob = "22222222-2222-4222-8222-222222222222";
const ordinaryJob = "33333333-3333-4333-8333-333333333333";
const readerJob = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";

type Manifest = { input_ref: string; content_hash: string; audience: string[] }[];

/** 只覆盖 source-scope 会发出的查询；形状与生产 SQL 前缀一致。 */
type FakeOptions = { governanceJobs?: string[]; manifest?: Manifest; stage?: string; factJob?: string };

const rows = (options: FakeOptions, query: string, values: unknown[]): unknown[] => {
  const governance = new Set(options.governanceJobs ?? []);
  if (query.includes("FROM artifact_evidence")) {
    return String(values[0]) !== evidenceId ? [] : [{ project_id: projectId, job_id: governance.has("evidence") ? governanceJob : ordinaryJob }];
  }
  if (query.includes("FROM canvas_nodes")) {
    return String(values[0]) !== factId ? [] : [{ project_id: projectId, job_id: options.factJob ?? null }];
  }
  if (query.includes("FROM jobs WHERE id=")) {
    const id = String(values[0]);
    return id === ordinaryJob ? [{ project_id: projectId, id: ordinaryJob }] : [];
  }
  if (query.includes("SELECT 1 FROM project_knowledge_job_assignments")) {
    return governance.has(String(values[0])) ? [{ "?column?": 1 }] : [];
  }
  if (query.includes("SELECT stage, input_manifest_json")) {
    return [{ stage: options.stage ?? "maker", input_manifest_json: options.manifest ?? [] }];
  }
  return [];
};

/** 只覆盖 source-scope 会发出的查询；形状与生产 SQL 前缀一致。 */
function fakeDb(options: FakeOptions = {}) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(rows(options, strings.join("?"), values))) as never;
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
  const manifest: Manifest = [{ input_ref: `evidence:${evidenceId}`, content_hash: "a".repeat(64), audience: ["maker"] }];
  const allowedDb = fakeDb({ governanceJobs: ["evidence", governanceJob], manifest, stage: "maker" });
  const resolved = await resolveSourceOwners(allowedDb, [source]);
  assert.equal(resolved.owners[0]!.governance, true);
  assert.equal(await actorMayReadGovernanceSources(allowedDb, { jobId: readerJob, projectId }, resolved.owners), true);

  const noRef = fakeDb({ governanceJobs: ["evidence", governanceJob], manifest: [], stage: "maker" });
  assert.equal(await actorMayReadGovernanceSources(noRef, { jobId: readerJob, projectId }, resolved.owners), false);

  const wrongStage = fakeDb({ governanceJobs: ["evidence", governanceJob], manifest, stage: "reviewer" });
  assert.equal(await actorMayReadGovernanceSources(wrongStage, { jobId: readerJob, projectId }, resolved.owners), false);

  const wrongHash = fakeDb({ governanceJobs: ["evidence", governanceJob], stage: "maker",
    manifest: [{ input_ref: `evidence:${evidenceId}`, content_hash: "b".repeat(64), audience: ["maker"] }] });
  assert.equal(await actorMayReadGovernanceSources(wrongHash, { jobId: readerJob, projectId }, resolved.owners), false);

  // 真实清单格式是 `kind:UUID`，裸 UUID 不能当成命中。
  const bareRef = fakeDb({ governanceJobs: ["evidence", governanceJob], stage: "maker",
    manifest: [{ input_ref: evidenceId, content_hash: "a".repeat(64), audience: ["maker"] }] });
  assert.equal(await actorMayReadGovernanceSources(bareRef, { jobId: readerJob, projectId }, resolved.owners), false,
    "清单 input_ref 必须是 kind:UUID");
});

test("来源不可用时明确计为 unresolved，未知 kind 不参与判定", async () => {
  const db = fakeDb();
  const gone = await resolveSourceOwners(db, [{ kind: "evidence", ref: "99999999-9999-4999-8999-999999999999" }]);
  assert.equal(gone.unresolved, 1, "定位不到的来源必须显式计数，不能当成「没有受限来源」");
  const unknown = await resolveSourceOwners(db, [{ kind: "feedback", ref: evidenceId }]);
  assert.equal(unknown.unresolved, 0, "没见过的来源形状不应导致知识被隐藏");
  assert.equal(unknown.owners.length, 0);
});

test("task 来源用 job_id 定位，不因为没有 ref 字段而被当成不可用", async () => {
  const db = fakeDb();
  const resolved = await resolveSourceOwners(db, [{ kind: "task", job_id: ordinaryJob }]);
  assert.equal(resolved.unresolved, 0);
  assert.equal(resolved.owners.length, 1);
  assert.equal(resolved.owners[0]!.job_id, ordinaryJob);
});

test("Fact 挂在治理 Job 上时同样按治理来源处理", async () => {
  const factSource = { kind: "fact", ref: factId, content_hash: "a".repeat(64) };
  const db = fakeDb({ governanceJobs: [governanceJob], factJob: governanceJob, stage: "maker",
    manifest: [{ input_ref: `fact:${factId}`, content_hash: "a".repeat(64), audience: ["maker"] }] });
  const resolved = await resolveSourceOwners(db, [factSource]);
  assert.equal(resolved.unresolved, 0);
  assert.equal(resolved.owners[0]!.governance, true, "canvas_nodes.job_id 属治理 Job 时必须识别为治理来源");
  assert.equal(await actorMayReadGovernanceSources(db, { jobId: readerJob, projectId }, resolved.owners), true);
  const missing = fakeDb({ governanceJobs: [governanceJob], factJob: governanceJob, stage: "maker", manifest: [] });
  assert.equal(await actorMayReadGovernanceSources(missing, { jobId: readerJob, projectId }, resolved.owners), false);

  // 普通项目的 Fact 不算私有：没有治理归属时不需要清单命中。
  const ordinary = fakeDb();
  const plain = await resolveSourceOwners(ordinary, [factSource]);
  assert.equal(plain.owners[0]!.governance, false);
  assert.equal(await actorMayReadGovernanceSources(ordinary, { jobId: readerJob, projectId }, plain.owners), true);
});
