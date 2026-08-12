import assert from "node:assert/strict";
import test from "node:test";
import {
  beginEffect,
  markAttemptInterrupted,
  requestAttemptCancel,
  settleAttemptTerminal,
  settleEffect,
  updateAttemptResource,
  updateAttemptSession,
  type AttemptDatabase,
} from "./application.js";
import { buildAttemptState, type AttemptState, type AttemptStatus } from "./model.js";

type FakeEffect = {
  effect_id: string;
  effect_kind: string;
  status: "effect_pending" | "settled" | "unknown";
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 只模拟 Attempt application seam 实际使用的 SQL 形状。
 * 每个调用都是同步线性化的，测试通过显式交错调用验证迟到结果不能复活终态。
 */
function fakeAttemptDatabase(initialState: AttemptState): {
  db: AttemptDatabase;
  read: () => { status: AttemptStatus; state: AttemptState; effect: FakeEffect | null };
} {
  let state = clone(initialState);
  let status: AttemptStatus = "active";
  let effect: FakeEffect | null = null;
  const row = () => ({
    id: state.attempt_id,
    job_id: state.job_id,
    status,
    phase: state.phase,
    state_json: clone(state),
    sandbox_id: state.sandbox_id,
    session_id: state.session_id,
    attempt_no: state.attempt_no,
    snapshot_identity_json: clone(state.snapshot_identity),
    outcome_json: clone(state.outcome),
  });
  const db = Object.assign(
    ((strings: TemplateStringsArray | Record<string, unknown>, ...values: unknown[]) => {
      // postgres.js 也会把对象传给 db({...}) 生成 INSERT 片段。
      if (!Array.isArray(strings)) return strings;
      const query = strings.join(" ").replace(/\s+/gu, " ").trim();
      if (query.includes("SELECT * FROM job_attempts WHERE id")) return status === "active" ? [row()] : [];
      if (query.includes("SELECT * FROM job_attempts WHERE job_id")) return status === "active" ? [row()] : [];
      if (query.includes("SELECT job_id FROM job_attempts")) return [{ job_id: state.job_id }];

      if (query.includes("INSERT INTO job_attempt_effects")) {
        const input = values.find((value): value is Record<string, unknown> => (
          Boolean(value) && typeof value === "object" && "effect_id" in (value as Record<string, unknown>)
        ));
        if (effect) return [];
        effect = {
          effect_id: String(input?.effect_id ?? "unknown"),
          effect_kind: String(input?.effect_kind ?? "unknown"),
          status: "effect_pending",
        };
        return [{ id: "effect-row" }];
      }
      if (query.includes("SELECT status FROM job_attempt_effects")) {
        return effect ? [{ status: effect.status }] : [];
      }
      if (query.includes("status = CASE") && query.includes("effect_kind = 'agent_run'")) {
        if (effect?.status === "effect_pending") {
          const terminalStatus = values.find((value): value is AttemptStatus => (
            value === "succeeded" || value === "failed" || value === "cancelled" || value === "timeout" || value === "orphan"
          ));
          effect.status = terminalStatus === "succeeded" && effect.effect_kind === "agent_run" ? "settled" : "unknown";
        }
        return [];
      }
      if (query.includes("UPDATE job_attempt_effects SET")) {
        if (!effect || effect.status !== "effect_pending") return [];
        const nextStatus = values.find((value): value is "settled" | "unknown" => value === "settled" || value === "unknown");
        effect.status = nextStatus ?? "unknown";
        return [{ effect_kind: effect.effect_kind }];
      }
      if (query.includes("UPDATE job_attempts SET")) {
        const nextState = values.find((value): value is AttemptState => (
          Boolean(value) && typeof value === "object" && (value as Record<string, unknown>).version === 1
            && (value as Record<string, unknown>).attempt_id === state.attempt_id
        ));
        if (nextState) state = clone(nextState);
        if (query.includes("phase = 'terminal'")) {
          const nextStatus = values.find((value): value is AttemptStatus => (
            value === "succeeded" || value === "failed" || value === "cancelled" || value === "timeout" || value === "orphan"
          ));
          if (nextStatus) status = nextStatus;
        } else if (query.includes("status = 'interrupted'")) {
          status = "interrupted";
        }
        return status === "active" || nextState ? [row()] : [];
      }
      throw new Error(`unexpected fake Attempt query: ${query}`);
    }) as unknown as AttemptDatabase,
    { json: (value: unknown) => value },
  );
  return {
    db,
    read: () => ({ status, state: clone(state), effect: effect ? clone(effect) : null }),
  };
}

function attemptState(): AttemptState {
  return buildAttemptState({
    attemptId: "attempt-race-1",
    jobId: "job-race-1",
    attemptNo: 1,
    snapshotIdentity: {
      snapshot_sha256: "a".repeat(64),
      agent_cli: "claude-code",
      adapter_id: "claude-code",
      adapter_version: "1.0.0",
      runtime_image_ref: "deepsonar-base@sha256:abc",
      runtime_image_key: "deepsonar-base",
    },
  });
}

test("省略 sessionId 时不写入 undefined 且保留原值", async () => {
  const state = {
    version: 1 as const,
    attempt_id: "attempt-1",
    job_id: "job-1",
    attempt_no: 1,
    phase: "preparing" as const,
    replay_policy: "never" as const,
    cancel_requested: false,
    current_effect_id: null,
    sandbox_id: "sandbox-old",
    session_id: "session-original",
    session_file: null,
    resource_labels: { "deepsonar.job": "job-1" },
    snapshot_identity: { agent_cli: "claude-code" },
    outcome: {},
  };
  let updateValues: unknown[] = [];
  const db = Object.assign(
    ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ");
      if (query.includes("UPDATE job_attempts SET")) updateValues = values;
      if (query.includes("SELECT * FROM job_attempts")) {
        return Promise.resolve([{ id: "attempt-1", job_id: "job-1", state_json: state }]);
      }
      if (query.includes("UPDATE job_attempts SET")) {
        return Promise.resolve([{ id: "attempt-1", job_id: "job-1", state_json: state }]);
      }
      throw new Error(`unexpected query: ${query}`);
    }) as unknown as AttemptDatabase,
    { json: (value: unknown) => value },
  );

  await updateAttemptResource(db, "attempt-1", { sandboxId: "sandbox-new", phase: "provisioned" });

  assert.ok(updateValues.length > 0);
  assert.ok(updateValues.every((value) => value !== undefined), "postgres.js 参数不得包含 undefined");
  const nextState = updateValues.find((value) => (
    value !== null && typeof value === "object" && !Array.isArray(value)
      && "session_id" in (value as Record<string, unknown>)
  )) as Record<string, unknown> | undefined;
  assert.equal(nextState?.session_id, "session-original");
});

test("结构化会话身份持久化到 Attempt total state 并拒绝越界路径", async () => {
  const { db, read } = fakeAttemptDatabase(attemptState());
  await updateAttemptSession(db, "attempt-race-1", {
    sessionId: "session-1",
    sessionFile: "/workspace/.deepsonar-home/.pi/agent/session.jsonl",
  });
  assert.equal(read().state.session_id, "session-1");
  assert.equal(read().state.session_file, "/workspace/.deepsonar-home/.pi/agent/session.jsonl");
  await assert.rejects(
    updateAttemptSession(db, "attempt-race-1", { sessionId: "session-2" }),
    /禁止切换会话/,
  );
  await assert.rejects(
    updateAttemptSession(db, "attempt-race-1", { sessionId: "session-1", sessionFile: "/workspace/other.jsonl" }),
    /禁止切换会话文件/,
  );
  await assert.rejects(
    updateAttemptSession(db, "attempt-race-1", { sessionId: "session-1", sessionFile: "/tmp/session.jsonl" }),
    /workspace/,
  );
  await assert.rejects(
    updateAttemptSession(db, "attempt-race-1", { sessionId: "session-1", sessionFile: "/workspace/../tmp/session.jsonl" }),
    /workspace/,
  );
});

test("取消先线性化时，禁止新效果且迟到 settlement 不能复活 Attempt", async () => {
  const { db, read } = fakeAttemptDatabase(attemptState());
  await beginEffect(db, "attempt-race-1", {
    effectId: "agent_run:1",
    kind: "agent_run",
    intent: { runner: "fake" },
  });
  await requestAttemptCancel(db, "job-race-1", "用户取消");
  await assert.rejects(
    beginEffect(db, "attempt-race-1", {
      effectId: "agent_resume:1",
      kind: "agent_resume",
      intent: { reason: "late retry" },
    }),
    /取消.*禁止启动/,
  );
  await settleAttemptTerminal(db, "job-race-1", "cancelled", { reason: "用户取消" }, "用户取消");
  const beforeLateSettlement = read();
  await settleEffect(db, "attempt-race-1", "agent_run:1", { status: "settled", outcome: { exit: 0 } });
  assert.deepEqual(read(), beforeLateSettlement);
  assert.equal(read().status, "cancelled");
  assert.equal(read().effect?.status, "unknown");
});

test("重启看到 effect_pending 时只产生 interrupted/unknown，不自动重放", async () => {
  const { db, read } = fakeAttemptDatabase(attemptState());
  await beginEffect(db, "attempt-race-1", {
    effectId: "provision:1",
    kind: "provision",
    resourceIdentity: { job_id: "job-race-1", attempt_id: "attempt-race-1" },
    intent: { image: "deepsonar-base@sha256:abc" },
  });
  await markAttemptInterrupted(db, "job-race-1", "scheduler restart");
  const afterRestart = read();
  assert.equal(afterRestart.status, "interrupted");
  assert.equal(afterRestart.state.phase, "interrupted");
  assert.equal(afterRestart.effect?.status, "unknown");
  await settleEffect(db, "attempt-race-1", "provision:1", { status: "settled", outcome: { sandbox_id: "late" } });
  assert.deepEqual(read(), afterRestart);
});

test("terminal 收口后，迟到的 Agent effect settlement 是幂等 no-op", async () => {
  const { db, read } = fakeAttemptDatabase(attemptState());
  await beginEffect(db, "attempt-race-1", {
    effectId: "agent_run:1",
    kind: "agent_run",
    intent: { runner: "fake" },
  });
  assert.equal(read().effect?.effect_kind, "agent_run");
  await settleAttemptTerminal(db, "job-race-1", "succeeded", { summary: "done" });
  const terminal = read();
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.effect?.status, "settled");
  await settleEffect(db, "attempt-race-1", "agent_run:1", { status: "unknown", error: "late process error" });
  assert.deepEqual(read(), terminal);
});
