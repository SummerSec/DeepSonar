import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeFindingCosts,
  buildQualityReport,
  classifyFindingOutcome,
  QUALITY_FINDING_COST_LIMIT,
  qualityRate,
  snapshotStrategy,
  type QualityContext,
  type QualityFindingRow,
  type QualityJobRow,
} from "./quality.js";

const NOW = new Date("2026-09-11T10:00:00.000Z");

function finding(overrides: Partial<QualityFindingRow> = {}): QualityFindingRow {
  return {
    id: "f1",
    project_id: "p1",
    canvas_id: "c1",
    job_id: "maker-1",
    title: "XSS",
    verify_status: "confirmed",
    disposition: "open",
    profile: "security.vulnerability",
    created_at: "2026-09-11T01:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<QualityJobRow> = {}): QualityJobRow {
  return {
    id: "maker-1",
    project_id: "p1",
    canvas_id: "c1",
    parent_job_id: null,
    type: "audit",
    status: "succeeded",
    finding_id: null,
    started_at: "2026-09-11T01:00:00.000Z",
    finished_at: "2026-09-11T01:10:00.000Z",
    created_at: "2026-09-11T00:50:00.000Z",
    error: null,
    agent_snapshot_json: { model: "claude", agent_cli: "claude-code", runtime_image: { image_key: "deepsonar-base" } },
    payload_json: {},
    ...overrides,
  };
}

function ctx(overrides: Partial<QualityContext> = {}): QualityContext {
  return {
    now: NOW,
    scope: { kind: "project", project_id: "p1", canvas_id: null },
    findings: [finding()],
    rounds: [],
    jobs: [job()],
    events: [],
    usage: [{ job_id: "maker-1", total_tokens: 100, provider: "anthropic", model: "claude" }],
    humanCanvasIds: [],
    canvases: [{ id: "c1", project_id: "p1", title: "登录" }],
    ...overrides,
  };
}

test("quality rates stay null on empty denominators", () => {
  assert.deepEqual(qualityRate(0, 0), { rate: null, numerator: 0, denominator: 0 });
  assert.deepEqual(qualityRate(2, 4), { rate: 0.5, numerator: 2, denominator: 4 });
});

test("false_positive classification prefers leftover verify status and rejected_fp", () => {
  assert.equal(classifyFindingOutcome({ verify_status: "false_positive", disposition: "open" }), "false_positive");
  assert.equal(classifyFindingOutcome({ verify_status: "confirmed", disposition: "rejected_fp" }), "false_positive");
  assert.equal(classifyFindingOutcome({ verify_status: "confirmed", disposition: "open" }), "confirmed");
  assert.equal(classifyFindingOutcome({ verify_status: "needs_human", disposition: "open" }), "needs_human");
  assert.equal(classifyFindingOutcome({ verify_status: "pending", disposition: "open" }), "open");
});

test("confirmation and false-positive rates use exclusive terminal outcomes", () => {
  const report = buildQualityReport(ctx({
    findings: [
      finding({ id: "a", verify_status: "confirmed" }),
      finding({ id: "b", job_id: "maker-1", verify_status: "false_positive" }),
      finding({ id: "c", job_id: "maker-1", verify_status: "needs_human" }),
      finding({ id: "d", job_id: "maker-1", verify_status: "pending" }),
    ],
  }));
  assert.deepEqual(report.findings.confirmation, { rate: 0.3333, numerator: 1, denominator: 3 });
  assert.deepEqual(report.findings.false_positive, { rate: 0.5, numerator: 1, denominator: 2 });
  assert.equal(report.findings.total, 4);
  assert.equal(report.query_plane, "current");
});

test("verify disagreement is proposed versus final outcome", () => {
  const report = buildQualityReport(ctx({
    rounds: [
      { finding_id: "f1", status: "confirmed", proposed_verdict: "confirmed", final_outcome: "confirmed", verify_job_id: "v1" },
      { finding_id: "f1", status: "rework", proposed_verdict: "confirmed", final_outcome: "rework", verify_job_id: "v2" },
      { finding_id: "f1", status: "running", proposed_verdict: null, final_outcome: null, verify_job_id: null },
    ],
  }));
  assert.deepEqual(report.verify.disagreement, { rate: 0.5, numerator: 1, denominator: 2 });
  assert.equal(report.verify.rounds.rework, 1);
  assert.deepEqual(report.verify.rework, { rate: 1, numerator: 1, denominator: 1 });
});

test("human intervention rate is canvases with any human signal over canvases with work", () => {
  const report = buildQualityReport(ctx({
    findings: [finding({ verify_status: "needs_human" })],
    jobs: [
      job(),
      job({ id: "hub-1", type: "hub_reason", status: "waiting_human", canvas_id: "c2" }),
      job({ id: "idle", type: "explore", status: "succeeded", canvas_id: "c3" }),
    ],
    events: [{ job_id: "hub-1", type: "human", event_id: "e1", payload_json: {}, created_at: NOW.toISOString() }],
    humanCanvasIds: ["c4"],
    usage: [],
  }));
  assert.equal(report.human.jobs_waiting, 1);
  assert.equal(report.human.jobs_requested, 1);
  assert.equal(report.human.findings_needs_human, 1);
  assert.equal(report.human.canvases_intervened, 3);
  assert.equal(report.human.canvases_with_work, 3);
  assert.deepEqual(report.human.intervention, { rate: 0.6667, numerator: 2, denominator: 3 });
});

test("per-finding cost splits shared origin tokens and keeps verify jobs whole", () => {
  const costs = attributeFindingCosts({
    findings: [
      finding({ id: "a", job_id: "maker" }),
      finding({ id: "b", job_id: "maker" }),
    ],
    jobs: [
      job({ id: "maker", started_at: "2026-09-11T01:00:00.000Z", finished_at: "2026-09-11T01:10:00.000Z" }),
      job({
        id: "verify-a",
        type: "verify_finding",
        finding_id: "a",
        started_at: "2026-09-11T01:20:00.000Z",
        finished_at: "2026-09-11T01:30:00.000Z",
      }),
    ],
    rounds: [{ finding_id: "a", status: "confirmed", proposed_verdict: "confirmed", final_outcome: "confirmed", verify_job_id: "verify-a" }],
    usage: [
      { job_id: "maker", total_tokens: 100, provider: "anthropic", model: "claude" },
      { job_id: "verify-a", total_tokens: 40, provider: "anthropic", model: "claude" },
    ],
  });
  assert.deepEqual(costs.get("a"), { tokens: 90, duration_ms: 900_000, job_count: 2 });
  assert.deepEqual(costs.get("b"), { tokens: 50, duration_ms: 300_000, job_count: 1 });
});

test("empty scope is a real zero and truncates long per-finding lists", () => {
  const empty = buildQualityReport(ctx({ findings: [], jobs: [], usage: [] }));
  assert.equal(empty.findings.total, 0);
  assert.equal(empty.findings.confirmation.rate, null);
  assert.equal(empty.cost.avg_tokens_per_finding, null);
  assert.equal(empty.cost.truncated, false);

  const many = Array.from({ length: QUALITY_FINDING_COST_LIMIT + 2 }, (_, index) =>
    finding({ id: `f${index}`, job_id: "maker-1", title: `n${index}` }));
  const report = buildQualityReport(ctx({ findings: many }));
  assert.equal(report.cost.per_finding.length, QUALITY_FINDING_COST_LIMIT);
  assert.equal(report.cost.truncated, true);
});

test("snapshot strategy reads frozen model and image without inventing capability packs", () => {
  assert.deepEqual(snapshotStrategy({
    model: "grok-4.6",
    agent_cli: "pi",
    runtime_image: { image_key: "deepsonar-kali-minimal", digest: "sha256:abc" },
  }), {
    model: "grok-4.6",
    provider: null,
    agent_cli: "pi",
    runtime_image_key: "deepsonar-kali-minimal",
    runtime_image_digest: "sha256:abc",
  });
});
