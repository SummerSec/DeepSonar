import assert from "node:assert/strict";
import test from "node:test";
import { updateAttemptResource, type AttemptDatabase } from "./application.js";

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
