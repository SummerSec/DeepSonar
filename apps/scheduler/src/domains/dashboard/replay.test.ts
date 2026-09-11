import assert from "node:assert/strict";
import test from "node:test";
import type { QualityContext, QualityFindingRow, QualityJobRow } from "./quality.js";
import {
  buildReplayBaseline,
  HUB_REPLAY_RECORD_KIND,
  HUB_REPLAY_SCHEMA_VERSION,
  parseHubPlan,
  parseReplayLimit,
} from "./replay.js";

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
    id: "hub-1",
    project_id: "p1",
    canvas_id: "c1",
    parent_job_id: null,
    type: "hub_reason",
    status: "succeeded",
    finding_id: null,
    started_at: "2026-09-11T02:00:00.000Z",
    finished_at: "2026-09-11T02:05:00.000Z",
    created_at: "2026-09-11T01:50:00.000Z",
    error: null,
    agent_snapshot_json: {
      model: "claude",
      provider: "anthropic",
      agent_cli: "claude-code",
      runtime_image: { image_key: "deepsonar-base", digest: "sha256:hub" },
    },
    payload_json: { trigger: { kind: "graph_progress" }, scheduling_purpose: "hub" },
    ...overrides,
  };
}

function ctx(overrides: Partial<QualityContext> = {}): QualityContext {
  return {
    now: NOW,
    scope: { kind: "task", project_id: "p1", canvas_id: "c1" },
    findings: [finding()],
    rounds: [],
    jobs: [job()],
    events: [{
      job_id: "hub-1",
      type: "hub_decision",
      event_id: "dec-1",
      payload_json: { intents: [{ role: "audit", description: "继续审计登录", runtime_image_key: "deepsonar-audit" }] },
      created_at: "2026-09-11T02:04:00.000Z",
    }],
    usage: [{ job_id: "hub-1", total_tokens: 80, provider: "anthropic", model: "claude" }],
    humanCanvasIds: [],
    canvases: [{ id: "c1", project_id: "p1", title: "登录" }],
    ...overrides,
  };
}

test("replay format version and reserved experience field are frozen", () => {
  assert.equal(HUB_REPLAY_SCHEMA_VERSION, 1);
  assert.equal(HUB_REPLAY_RECORD_KIND, "hub_replay");
  assert.deepEqual(parseHubPlan({ complete: { from: [], description: "本轮收敛完成" } }, "e1"), {
    kind: "complete",
    complete_description: "本轮收敛完成",
    intents: [],
    event_id: "e1",
  });
  assert.equal(parseHubPlan({ payload_file: "hub_decision_payload.json" }, null).kind, "payload_file");
  assert.equal(parseReplayLimit("3"), 3);
  assert.equal(parseReplayLimit("999"), 200);
});

test("buildReplayBaseline records current hub rounds without inventing recalled experiences", () => {
  const baseline = buildReplayBaseline(ctx({
    jobs: [
      job(),
      job({
        id: "audit-1",
        type: "audit",
        parent_job_id: "hub-1",
        created_at: "2026-09-11T02:06:00.000Z",
        started_at: "2026-09-11T02:06:00.000Z",
        finished_at: "2026-09-11T02:16:00.000Z",
      }),
      job({
        id: "hub-2",
        created_at: "2026-09-11T03:00:00.000Z",
        started_at: "2026-09-11T03:00:00.000Z",
        finished_at: "2026-09-11T03:01:00.000Z",
        payload_json: { trigger: { kind: "canvas_idle" }, scheduling_purpose: "hub" },
        agent_snapshot_json: { model: "claude" },
      }),
    ],
    findings: [
      finding(),
      finding({ id: "late", created_at: "2026-09-11T04:00:00.000Z", verify_status: "pending" }),
    ],
  }), 10);

  assert.equal(baseline.query_plane, "history");
  assert.deepEqual(baseline.format, { schema_version: 1, record_kind: "hub_replay" });
  assert.equal(baseline.total, 2);
  assert.equal(baseline.records[0]!.round_index, 1);
  assert.equal(baseline.records[1]!.round_index, 2);
  assert.deepEqual(baseline.records[0]!.recalled_experiences, []);
  assert.equal(baseline.records[0]!.plan.kind, "intents");
  assert.deepEqual(baseline.records[0]!.plan.intents, [{
    role: "audit",
    description: "继续审计登录",
    runtime_image_key: "deepsonar-audit",
  }]);
  assert.deepEqual(baseline.records[0]!.execution.child_jobs, [{
    id: "audit-1",
    type: "audit",
    status: "succeeded",
    finding_id: null,
  }]);
  assert.equal(baseline.records[0]!.input.finding_counts.total, 1);
  assert.equal(baseline.records[1]!.input.finding_counts.total, 1);
  assert.equal(baseline.records[0]!.quality.confirmation_rate, 1);
  assert.equal(baseline.records[0]!.cost.hub_tokens, 80);
  assert.equal(baseline.records[0]!.strategy.runtime_image_key, "deepsonar-base");
  assert.equal(baseline.records[1]!.plan.kind, "none");
});

test("replay limit truncates without rewriting earlier rounds", () => {
  const baseline = buildReplayBaseline(ctx({
    jobs: [
      job({ id: "hub-a", created_at: "2026-09-11T01:00:00.000Z" }),
      job({ id: "hub-b", created_at: "2026-09-11T02:00:00.000Z" }),
      job({ id: "hub-c", created_at: "2026-09-11T03:00:00.000Z" }),
    ],
    events: [],
  }), 2);
  assert.equal(baseline.truncated, true);
  assert.equal(baseline.records.length, 2);
  assert.deepEqual(baseline.records.map((row) => row.job_id), ["hub-a", "hub-b"]);
});
