import type { KnowledgeArm, KnowledgeInputManifestEntry, KnowledgeJobAssignment } from "@deepsonar/shared-types";
import { KNOWLEDGE_CASE_KINDS, KNOWLEDGE_LIMITS } from "@deepsonar/shared-types";
import { requiredArms } from "./evaluation.js";
import { KNOWLEDGE_FIXED_CASES } from "./case-policy.js";
import type { CreateJobInput, EnsureCanvasInput } from "../../core.js";
import type { sql } from "../../db.js";
import { onKnowledgeJobTerminal } from "./recovery.js";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { canonical, sha256 } from "./types.js";

type Db = typeof sql;
type Row = Record<string, unknown>;
type Terminal = "succeeded" | "failed" | "timeout" | "cancelled" | "orphan";
type CreateJob = (tx: Db, input: CreateJobInput, assignment?: KnowledgeJobAssignment) => Promise<{ created: Row }>;
type EnsureCanvas = (tx: Db, input: EnsureCanvasInput) => Promise<string>;
type Stage = "maker" | "evaluator" | "reviewer" | "trial";
type PlanCase = { id: string; kind: string; prompt: string; expected: string; critical: boolean };
type TrialIndex = { jobId: string; projectId: string; payload: Record<string, unknown>; evidence: Row[] };
type PreparedEvidence = { proposalId: string; generation: number; blobs: Map<string, { hash: string; bytes: number }> };

export interface KnowledgeWorkSchedulerInput {
  db: Db;
  createJobInTransaction: CreateJob;
  ensureCanvasForTaskInTransaction: EnsureCanvas;
  governanceHash: string;
}

const terminalStatuses = ["succeeded", "failed", "timeout", "cancelled", "orphan"] as const;
function isTerminal(status: unknown): status is Terminal {
  return terminalStatuses.includes(status as Terminal);
}
function entries(value: unknown): KnowledgeInputManifestEntry[] {
  return Array.isArray(value) ? value as KnowledgeInputManifestEntry[] : [];
}
function plan(value: unknown): PlanCase[] {
  return Array.isArray(value) ? value as PlanCase[] : [];
}
function validPlan(cases: PlanCase[]): boolean {
  const fixed = KNOWLEDGE_FIXED_CASES as Record<string, { prompt: string; expected: string }>;
  return cases.length === KNOWLEDGE_CASE_KINDS.length
    && new Set(cases.map((item) => item.id)).size === cases.length
    && new Set(cases.map((item) => item.kind)).size === cases.length
    && KNOWLEDGE_CASE_KINDS.every((kind) => cases.some((item) => item.kind === kind))
    && cases.every((item) => item.critical === true &&
      (item.kind === "target" || (item.prompt === fixed[item.kind]?.prompt && item.expected === fixed[item.kind]?.expected)));
}
function roleFor(stage: Stage): string {
  return stage === "trial" ? "test" : stage === "reviewer" ? "review" : "analyze";
}
function promptFor(stage: Stage, work: Row, proposal?: Row, trial?: { testCase: PlanCase; arm: string }): string {
  const reference = `work=${work.id}`;
  if (stage === "maker") return `整理当前 Job 冻结的项目证据，提出项目知识候选。${reference}。${proposal ? `前一提案=${proposal.id} revision=${proposal.revision} state=${proposal.state}；仅可提交 parent_proposal_ref 为该提案、revision=${Number(proposal.revision) + 1} 的修订。` : "首次提案 revision=1。"}逐项使用 read_knowledge_input，调用 propose_project_knowledge；不得自行批准或激活。`;
  if (stage === "trial" && trial) return `执行独立知识试验。${reference} proposal=${proposal?.id} case=${trial.testCase.id} kind=${trial.testCase.kind} arm=${trial.arm}。任务：${trial.testCase.prompt}。预期：${trial.testCase.expected}。cross_project/revocation case 必须用 read_knowledge_input 实际请求冻结的 platform-probe 并记录拒绝码。实际执行后，在工作区写 JSON，至少含 case_id=${JSON.stringify(trial.testCase.id)}、arm=${JSON.stringify(trial.arm)}、outcome（pass/fail/unexecuted）和实际 observations；用 publish_shared_asset 发布为当前项目资产，取得 asset version UUID 与 content hash；随后 emit_fact，artifact.evidence 中填 uri='asset:<version_uuid>'、sha256=<相同内容 hash>，并描述真实观察。不得只提交文字或预期结果；无环境则记录 unexecuted，禁止编造成功。最后 mark_job_done。`;
  if (stage === "evaluator") return `独立评测项目知识候选。${reference} proposal=${proposal?.id} input_digest=${proposal?.input_digest}。核对每个 case×arm 的独立 Job/Attempt、证据和结果，调用 submit_knowledge_evaluation；缺项或不可验证时明确 needs_eval。`;
  return `独立审查项目知识候选。${reference} proposal=${proposal?.id} input_digest=${proposal?.input_digest}。核对冻结输入、评测、安全用例、来源、基线和治理 hash，调用 review_project_knowledge；maker/evaluator 结论不能代替独立审查。`;
}

async function candidateEntry(tx: Db, proposal: Row): Promise<KnowledgeInputManifestEntry[]> {
  if (!proposal.candidate_version_id) return [];
  const [row] = await tx`SELECT v.id,v.project_id,v.content_sha256,b.bytes
    FROM project_knowledge_versions v JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
    WHERE v.id=${String(proposal.candidate_version_id)} AND v.revoked_at IS NULL`;
  if (!row) throw new Error("knowledge_candidate_missing");
  return [{
    input_ref: `candidate:${row.id}`, kind: "candidate", project_id: String(row.project_id),
    content_hash: String(row.content_sha256), blob_hash: String(row.content_sha256),
    bytes: Number(row.bytes), audience: ["maker", "evaluator", "reviewer", "trial"],
  }];
}

async function baselineEntries(tx: Db, proposal: Row): Promise<KnowledgeInputManifestEntry[]> {
  const refs = Array.isArray(proposal.base_refs_json) ? proposal.base_refs_json as Array<{ version_ref?: string }> : [];
  const result: KnowledgeInputManifestEntry[] = [];
  for (const ref of refs) {
    if (!ref.version_ref) throw new Error("knowledge_baseline_ref_missing");
    const [row] = await tx`SELECT v.id,v.project_id,v.content_sha256,b.bytes
      FROM project_knowledge_versions v JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
      WHERE v.id=${ref.version_ref} AND v.revoked_at IS NULL`;
    if (!row) throw new Error("knowledge_baseline_version_missing");
    result.push({
      input_ref: `baseline:${row.id}`, kind: "evaluation", project_id: String(row.project_id),
      content_hash: String(row.content_sha256), blob_hash: String(row.content_sha256),
      bytes: Number(row.bytes), audience: ["maker", "trial", "evaluator", "reviewer"],
    });
  }
  return result;
}

async function collectTrialIndexes(db: Db, proposalId: string, inputDigest: string): Promise<TrialIndex[]> {
  const trials = await db`SELECT a.case_id,a.arm,j.id AS job_id,j.project_id,latest.id AS attempt_id
    FROM project_knowledge_job_assignments a JOIN jobs j ON j.id=a.job_id
    JOIN LATERAL (SELECT id,status FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE a.proposal_id=${proposalId} AND a.stage='trial' AND j.status='succeeded'
      AND latest.status='succeeded' AND a.input_digest=${inputDigest}
    ORDER BY a.case_id,a.arm`;
  const result: TrialIndex[] = [];
  for (const trial of trials) {
    const evidence = await db`SELECT e.id,e.sha256,e.statement,e.uri,v.id AS asset_version_id,v.bytes
      FROM artifact_evidence e JOIN artifacts ar ON ar.id=e.artifact_id
      JOIN events ev ON ev.event_id=ar.source_event_id AND ev.job_id=ar.job_id
      JOIN shared_asset_versions v ON e.uri='asset:' || v.id::text AND v.content_sha256=e.sha256
      JOIN shared_assets s ON s.id=v.asset_id AND s.project_id=ar.project_id
        AND s.created_by_job_id=ar.job_id AND v.created_by_job_id=ar.job_id
      WHERE ar.job_id=${String(trial.job_id)} AND ev.attempt_id=${String(trial.attempt_id)}
        AND e.sha256 IS NOT NULL AND s.status='active'
      ORDER BY e.id LIMIT 21`;
    if (evidence.length > 20) throw new Error("knowledge_trial_evidence_budget_exhausted");
    if (!evidence.length) throw new Error("knowledge_trial_evidence_missing");
    if (evidence.some((item) => Number(item.bytes) > KNOWLEDGE_LIMITS.readBytes))
      throw new Error("knowledge_trial_evidence_too_large");
    const payload = {
      proposal_id: proposalId, input_digest: inputDigest, case_id: trial.case_id, arm: trial.arm,
      trial_job_id: trial.job_id, trial_attempt_id: trial.attempt_id,
      evidence: evidence.map((item) => ({ id: item.id, sha256: item.sha256,
        asset_version_id: item.asset_version_id, uri: item.uri, bytes: item.bytes,
        statement: item.statement })),
    };
    result.push({ jobId: String(trial.job_id), projectId: String(trial.project_id), payload, evidence });
  }
  return result;
}

async function trialEvidenceEntries(tx: Db, proposalId: string, inputDigest: string,
  prepared: PreparedEvidence): Promise<KnowledgeInputManifestEntry[]> {
  const [proposal] = await tx`SELECT action,evaluation_plan_json,input_digest
    FROM project_knowledge_proposals WHERE id=${proposalId} FOR SHARE`;
  if (!proposal || proposal.input_digest !== inputDigest) throw new Error("knowledge_trial_proposal_changed");
  const expectedPairs = new Set(plan(proposal.evaluation_plan_json)
    .flatMap((testCase) => requiredArms(String(proposal.action)).map((arm) => `${testCase.id}:${arm}`)));
  const assignments = await tx`SELECT case_id,arm FROM project_knowledge_job_assignments
    WHERE proposal_id=${proposalId} AND stage='trial'`;
  if (assignments.length !== expectedPairs.size || assignments.length !== prepared.blobs.size
    || assignments.some((assignment) => !expectedPairs.delete(`${assignment.case_id}:${assignment.arm}`))
    || expectedPairs.size) throw new Error("knowledge_trial_matrix_changed");
  const indexes = await collectTrialIndexes(tx, proposalId, inputDigest);
  if (prepared.proposalId !== proposalId || indexes.length !== prepared.blobs.size)
    throw new Error("knowledge_trial_index_changed");
  const result: KnowledgeInputManifestEntry[] = [];
  for (const item of indexes) {
    const expected = prepared.blobs.get(item.jobId);
    const bytes = Buffer.from(canonical(item.payload), "utf8");
    if (!expected || expected.hash !== sha256(bytes) || expected.bytes !== bytes.length)
      throw new Error("knowledge_trial_index_changed");
    await registerKnowledgeBlob(tx, expected.hash, expected.bytes);
    result.push({
      input_ref: `evaluation:${item.jobId}`, kind: "evaluation", project_id: item.projectId,
      content_hash: expected.hash, blob_hash: expected.hash, bytes: expected.bytes, audience: ["evaluator", "reviewer"],
    });
    for (const evidence of item.evidence) result.push({
      input_ref: `evaluation:${evidence.id}`, kind: "evaluation", project_id: item.projectId,
      content_hash: String(evidence.sha256), blob_hash: String(evidence.sha256), bytes: Number(evidence.bytes),
      audience: ["evaluator", "reviewer"],
    });
  }
  return result;
}

async function block(tx: Db, workId: string, reason: string, proposalId?: string): Promise<void> {
  if (proposalId) await tx`UPDATE project_knowledge_proposals SET state='needs_eval'
    WHERE id=${proposalId} AND state IN ('evaluating','review_pending')`;
  await tx`UPDATE project_knowledge_work SET state='blocked',active_job_id=NULL,claim_expires_at=NULL,
    reason=${reason},updated_at=now() WHERE id=${workId} AND state='running'`;
}

export function createKnowledgeWorkScheduler(input: KnowledgeWorkSchedulerInput) {
  const { db, createJobInTransaction, ensureCanvasForTaskInTransaction } = input;

  async function prepareTrialEvidence(workId: string): Promise<PreparedEvidence | undefined> {
    const [work] = await db`SELECT w.generation,w.stage,p.id AS proposal_id,p.action,p.input_digest,p.evaluation_plan_json
      FROM project_knowledge_work w JOIN LATERAL (
        SELECT id,action,input_digest,evaluation_plan_json FROM project_knowledge_proposals
        WHERE work_id=w.id ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1
      ) p ON true WHERE w.id=${workId} AND w.state='running' AND w.active_job_id IS NULL
        AND w.stage IN ('evaluator','reviewer')`;
    if (!work) return undefined;
    const expected = plan(work.evaluation_plan_json).length * requiredArms(String(work.action)).length;
    if (!expected) return undefined;
    const [count] = await db`SELECT COUNT(*)::int AS n FROM project_knowledge_job_assignments a
      JOIN jobs j ON j.id=a.job_id
      JOIN LATERAL (SELECT status FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
      WHERE a.proposal_id=${String(work.proposal_id)} AND a.stage='trial'
        AND a.input_digest=${String(work.input_digest)} AND j.status='succeeded' AND latest.status='succeeded'`;
    if (Number(count?.n) !== expected) return undefined;
    const indexes = await collectTrialIndexes(db, String(work.proposal_id), String(work.input_digest));
    if (indexes.length !== expected) return undefined;
    const blobs = new Map<string, { hash: string; bytes: number }>();
    for (const item of indexes) {
      if (Buffer.byteLength(canonical(item.payload), "utf8") > KNOWLEDGE_LIMITS.bundleBytes)
        throw new Error("knowledge_trial_index_too_large");
      blobs.set(item.jobId, await writeKnowledgeBlob(db, item.payload));
    }
    return { proposalId: String(work.proposal_id), generation: Number(work.generation), blobs };
  }

  async function createAssignedJob(
    tx: Db, work: Row, stage: Stage, manifest: KnowledgeInputManifestEntry[],
    proposal?: Row, trial?: { testCase: PlanCase; arm: KnowledgeArm },
  ): Promise<string> {
    const workId = String(work.id);
    const projectId = String(work.project_id);
    const canvasId = String(work.canvas_id);
    const prompt = promptFor(stage, work, proposal, trial);
    const assignment: KnowledgeJobAssignment = {
      work_id: workId, stage, inputs: manifest, governance_hash: String(work.governance_hash),
      ...(proposal && stage !== "maker" ? { proposal_id: String(proposal.id), input_digest: String(proposal.input_digest) } : {}),
      ...(trial ? { case_id: trial.testCase.id, arm: trial.arm } : {}),
    };
    const remaining = KNOWLEDGE_LIMITS.seconds - Number(work.run_seconds);
    if (remaining <= 0) throw new Error("knowledge_run_budget_exhausted");
    const created = await createJobInTransaction(tx, {
      projectId, canvasId, parentJobId: (work.origin_job_id as string | null) ?? undefined,
      type: roleFor(stage), timeoutSec: remaining, payload: {
        knowledge_work_id: workId, knowledge_stage: stage,
        intent: { description: `项目知识 ${stage}`, prompt, from: [] },
      },
    }, assignment);
    const jobId = String(created.created.id);
    await tx`INSERT INTO project_knowledge_job_assignments
      (job_id,project_id,work_id,proposal_id,stage,case_id,arm,input_digest,input_manifest_json)
      VALUES(${jobId},${projectId},${workId},${proposal && stage !== "maker" ? String(proposal.id) : null},
        ${stage},${trial?.testCase.id ?? null},${trial?.arm ?? null},
        ${proposal && stage !== "maker" ? String(proposal.input_digest) : null},${tx.json(manifest as never)})`;
    const [position] = await tx`SELECT COALESCE(MAX(y),100)+140 AS next_y FROM canvas_nodes WHERE canvas_id=${canvasId}`;
    const [node] = await tx`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,body_json,x,y,status)
      VALUES(${canvasId},${jobId},'intent',${`项目知识 ${stage}`},
        ${tx.json({ knowledge_work_id: workId, stage, proposal_id: proposal ? String(proposal.id) : null, case_id: trial?.testCase.id ?? null, arm: trial?.arm ?? null })},
        440,${Number(position?.next_y ?? 240)},'pending') RETURNING id`;
    const [root] = await tx`SELECT id FROM canvas_nodes WHERE canvas_id=${canvasId} AND node_type='root' LIMIT 1`;
    if (root) await tx`INSERT INTO canvas_edges(canvas_id,from_node_id,to_node_id,edge_type)
      VALUES(${canvasId},${String(root.id)},${String(node!.id)},'next') ON CONFLICT DO NOTHING`;
    await tx`UPDATE project_knowledge_work SET active_job_id=${jobId},job_count=job_count+1,
      claim_expires_at=NULL,updated_at=now() WHERE id=${workId} AND state='running'`;
    return jobId;
  }

  async function drive(workId: string, prepared?: PreparedEvidence): Promise<boolean> {
    return db.begin(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [before] = await tx`SELECT * FROM project_knowledge_work WHERE id=${workId}`;
      if (!before || before.state !== "running") return false;
      let canvasId = String(before.canvas_id ?? "");
      const [existing] = canvasId ? await tx`SELECT target_json FROM canvases WHERE id=${canvasId}` : [];
      const target = (existing?.target_json ?? {}) as Row;
      if (target.knowledge_work_id !== workId) {
        canvasId = await ensureCanvasForTaskInTransaction(tx, {
          projectId: String(before.project_id),
          title: `项目知识整理 ${workId}`,
          target: { kind: "standard", title: `项目知识整理 ${workId}`,
            goal: "受治理的项目知识整理与独立评测", knowledge_work_id: workId },
          triggerSource: "project_knowledge", triggerEventId: workId,
        });
      }
      await tx`SELECT id FROM canvases WHERE id=${canvasId} FOR UPDATE`;
      const [work] = await tx`SELECT * FROM project_knowledge_work WHERE id=${workId}`;
      if (!work || work.state !== "running") return false;
      if (String(work.governance_hash) !== input.governanceHash) {
        await block(tx, workId, "governance_baseline_changed");
        return true;
      }
      if (String(work.canvas_id ?? "") !== canvasId) {
        await tx`UPDATE project_knowledge_work SET canvas_id=${canvasId},updated_at=now() WHERE id=${workId}`;
        work.canvas_id = canvasId;
      }
      if (Number(work.job_count) >= KNOWLEDGE_LIMITS.jobs) {
        await block(tx, workId, "job_budget_exhausted");
        return true;
      }
      if (Number(work.run_seconds) >= KNOWLEDGE_LIMITS.seconds || Number(work.revision_count) > KNOWLEDGE_LIMITS.revisions) {
        await block(tx, workId, "work_budget_exhausted");
        return true;
      }
      if (work.active_job_id) {
        const [active] = await tx`SELECT id,project_id,canvas_id,status,started_at,finished_at
          FROM jobs WHERE id=${String(work.active_job_id)}`;
        if (!active) { await block(tx, workId, "active_job_missing"); return true; }
        if (!isTerminal(active.status)) return false;
        await onKnowledgeJobTerminal(tx, active as { id: unknown; project_id?: unknown; canvas_id?: unknown; started_at?: unknown; finished_at?: unknown }, active.status);
        return true;
      }
      if (work.stage === "maker") {
        const [prior] = await tx`SELECT p.* FROM project_knowledge_proposals p
          WHERE p.work_id=${workId} ORDER BY p.revision DESC,p.created_at DESC LIMIT 1`;
        const makers = await tx`SELECT 1 FROM project_knowledge_job_assignments
          WHERE work_id=${workId} AND stage='maker' LIMIT 1`;
        if (makers.length && (!prior || prior.state !== "needs_eval" || Number(work.revision_count) >= KNOWLEDGE_LIMITS.revisions)) {
          await block(tx, workId, "maker_revision_unavailable");
          return true;
        }
        const manifest = prior
          ? [...entries(work.input_manifest_json), ...await baselineEntries(tx, prior), ...await candidateEntry(tx, prior)]
          : entries(work.input_manifest_json);
        await createAssignedJob(tx, work, "maker", manifest, prior);
        return true;
      }
      const [proposal] = await tx`SELECT * FROM project_knowledge_proposals
        WHERE work_id=${workId} ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1`;
      if (!proposal) { await block(tx, workId, "proposal_missing"); return true; }
      const proposalId = String(proposal.id);
      if (["active", "retired"].includes(String(proposal.state))) {
        await tx`UPDATE project_knowledge_work SET state='completed',stage='settle',updated_at=now()
          WHERE id=${workId}`;
        return true;
      }
      if (proposal.state === "rejected" || work.stage === "settle") {
        await block(tx, workId, "review_rejected_or_unsettled", proposalId);
        return true;
      }
      if (proposal.state === "needs_eval" || proposal.state === "blocked") {
        await block(tx, workId, `proposal_${proposal.state}`);
        return true;
      }
      const [maker] = await tx`SELECT j.status FROM jobs j WHERE j.id=${String(proposal.maker_job_id)}`;
      if (maker?.status !== "succeeded") return false;
      const candidate = await candidateEntry(tx, proposal);
      const baseline = await baselineEntries(tx, proposal);
      if (work.stage === "evaluator") {
        const cases = plan(proposal.evaluation_plan_json);
        if (!validPlan(cases)) { await block(tx, workId, "evaluation_plan_incomplete", proposalId); return true; }
        const pairs = cases.flatMap((testCase) => requiredArms(String(proposal.action)).map((arm) => ({ testCase, arm: arm as KnowledgeArm })));
        if (Number(work.job_count) + pairs.length - Number((await tx`SELECT COUNT(*)::int AS n FROM project_knowledge_job_assignments WHERE proposal_id=${proposalId} AND stage='trial'`)[0]?.n ?? 0) + 1 > KNOWLEDGE_LIMITS.jobs) {
          await block(tx, workId, "trial_job_budget_exhausted", proposalId);
          return true;
        }
        const trials = await tx`SELECT a.case_id,a.arm,j.status,j.id,j.started_at,j.finished_at,
          (SELECT status FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) AS attempt_status
          FROM project_knowledge_job_assignments a JOIN jobs j ON j.id=a.job_id
          WHERE a.proposal_id=${proposalId} AND a.stage='trial'`;
        if (trials.length > pairs.length) {
          await block(tx, workId, "trial_matrix_excess", proposalId);
          return true;
        }
        for (const pair of pairs) {
          const found = trials.find((trial) => trial.case_id === pair.testCase.id && trial.arm === pair.arm);
          if (!found) {
            const armInputs = pair.arm === "candidate" ? candidate : pair.arm === "baseline" ? baseline : [];
            const probe = pair.testCase.kind === "cross_project" ? [{
              input_ref: "platform-probe:foreign-scope", kind: "evidence" as const,
              project_id: "00000000-0000-0000-0000-000000000000", content_hash: "0".repeat(64),
              blob_hash: "0".repeat(64), bytes: 0, audience: ["trial" as const],
            }] : pair.testCase.kind === "revocation" ? [{
              input_ref: "platform-probe:revoked", kind: "evidence" as const,
              project_id: String(work.project_id), content_hash: "0".repeat(64),
              blob_hash: "0".repeat(64), bytes: 0, audience: ["trial" as const],
            }] : [];
            const trialInputs: KnowledgeInputManifestEntry[] = [...armInputs, ...probe];
            await createAssignedJob(tx, work, "trial", trialInputs, proposal, pair);
            return true;
          }
          if (isTerminal(found.status) && (found.status !== "succeeded" || found.attempt_status !== "succeeded")) {
            await block(tx, workId, "trial_not_successful", proposalId);
            return true;
          }
          if (found.status !== "succeeded") return false;
        }
        const [evaluation] = await tx`SELECT id FROM project_knowledge_evaluations
          WHERE proposal_id=${proposalId} AND kind='behavior' LIMIT 1`;
        if (evaluation) return false;
        const existingEval = await tx`SELECT j.id,j.status FROM project_knowledge_job_assignments a
          JOIN jobs j ON j.id=a.job_id WHERE a.proposal_id=${proposalId} AND a.stage='evaluator' LIMIT 1`;
        if (existingEval.length) { await block(tx, workId, "evaluator_terminal_without_record", proposalId); return true; }
        if (!prepared || prepared.proposalId !== proposalId || prepared.generation !== Number(work.generation)) return false;
        const manifest = [...entries(work.input_manifest_json), ...baseline, ...candidate,
          ...await trialEvidenceEntries(tx, proposalId, String(proposal.input_digest), prepared)];
        await createAssignedJob(tx, work, "evaluator", manifest, proposal);
        return true;
      }
      if (work.stage === "reviewer") {
        const [behavior] = await tx`SELECT id FROM project_knowledge_evaluations
          WHERE proposal_id=${proposalId} AND kind='behavior' LIMIT 1`;
        if (!behavior) { await block(tx, workId, "behavior_evaluation_missing", proposalId); return true; }
        const existingReview = await tx`SELECT j.id,j.status FROM project_knowledge_job_assignments a
          JOIN jobs j ON j.id=a.job_id WHERE a.proposal_id=${proposalId} AND a.stage='reviewer' LIMIT 1`;
        if (existingReview.length) { await block(tx, workId, "reviewer_terminal_without_record", proposalId); return true; }
        if (!prepared || prepared.proposalId !== proposalId || prepared.generation !== Number(work.generation)) return false;
        const manifest = [...entries(work.input_manifest_json), ...baseline, ...candidate,
          ...await trialEvidenceEntries(tx, proposalId, String(proposal.input_digest), prepared)];
        await createAssignedJob(tx, work, "reviewer", manifest, proposal);
        return true;
      }
      await block(tx, workId, "unknown_work_stage", proposalId);
      return true;
    });
  }

  async function claimPending(stopped: () => boolean): Promise<void> {
    const candidates = await db`SELECT id FROM project_knowledge_work w
      WHERE state='pending' AND next_attempt_at<=now()
        AND NOT EXISTS(SELECT 1 FROM project_knowledge_work r WHERE r.project_id=w.project_id AND r.state='running')
      ORDER BY next_attempt_at,id LIMIT 8`;
    for (const candidate of candidates) {
      if (stopped()) return;
      try {
        await db.begin(async (tx) => {
          if (stopped()) return;
          const [locked] = await tx`SELECT id,project_id FROM project_knowledge_work
            WHERE id=${String(candidate.id)} AND state='pending' AND next_attempt_at<=now()
            FOR UPDATE SKIP LOCKED`;
          if (stopped() || !locked) return;
          const active = await tx`SELECT 1 FROM project_knowledge_work
            WHERE project_id=${String(locked.project_id)} AND state='running' LIMIT 1`;
          if (stopped() || active.length) return;
          await tx`UPDATE project_knowledge_work SET state='running',
            claim_expires_at=now()+interval '30 seconds',updated_at=now()
            WHERE id=${String(locked.id)}`;
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
      }
    }
  }

  async function tick(stopped: () => boolean = () => false): Promise<number> {
    if (stopped()) return 0;
    await claimPending(stopped);
    if (stopped()) return 0;
    const rows = await db`SELECT id FROM project_knowledge_work WHERE state='running'
      ORDER BY updated_at,id LIMIT 16`;
    let progressed = 0;
    for (const row of rows) {
      if (stopped()) break;
      try {
        const workId = String(row.id);
        const prepared = await prepareTrialEvidence(workId);
        if (stopped()) break;
        if (await drive(workId, prepared)) progressed++;
      } catch (error) {
        if (stopped()) break;
        const marker = typeof (error as { code?: unknown } | null)?.code === "string"
          ? String((error as { code: string }).code).slice(0, 40)
          : error instanceof Error ? error.name : "unknown";
        // generation is a domain revision marker, not a retry counter.
        const [current] = await db`SELECT reason FROM project_knowledge_work
          WHERE id=${String(row.id)} AND state='running' AND active_job_id IS NULL`;
        if (stopped()) break;
        if (!current) continue;
        const retries = Number(/^scheduler_admission_retry:(\d+):/.exec(String(current.reason ?? ""))?.[1] ?? 0) + 1;
        await db`UPDATE project_knowledge_work SET state=${retries >= 3 ? "blocked" : "pending"},
          claim_expires_at=NULL,next_attempt_at=now()+interval '30 seconds',
          reason=${`scheduler_admission_retry:${retries}:${marker}`},updated_at=now()
          WHERE id=${String(row.id)} AND state='running' AND active_job_id IS NULL`;
      }
    }
    return progressed;
  }

  return {
    tick,
    onTerminal: (tx: Db, job: { id: unknown; project_id?: unknown; canvas_id?: unknown; started_at?: unknown; finished_at?: unknown }, status: Terminal) =>
      onKnowledgeJobTerminal(tx, job, status),
  };
}
