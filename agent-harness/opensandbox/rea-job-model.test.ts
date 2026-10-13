import assert from "node:assert/strict";
import test from "node:test";
import { startReaJobModel } from "./rea-job-model.js";

async function post(url: string, body: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

test("REA loopback model runs actor then ends after successful tool result", async () => {
  const model = await startReaJobModel();
  try {
    const first = await post(`${model.url}/v1/messages`, { model: "claude-sonnet-4-5", stream: false, messages: [] });
    assert.equal(first.stop_reason, "tool_use");
    assert.equal(first.content[0]?.name, "Bash");
    assert.match(first.content[0]?.input?.command ?? "", /rea-job-actor\.py/);

    const second = await post(`${model.url}/v1/messages`, {
      model: "claude-sonnet-4-5",
      stream: false,
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_rea_e2e", content: "REA_E2E_DONE\nExit code 0" }],
      }],
    });
    assert.equal(second.stop_reason, "end_turn");
    assert.match(second.content[0]?.text ?? "", /Control API/);
  } finally {
    await model.close();
  }
});

test("REA loopback model reports actor failure without mark_job_done", async () => {
  const model = await startReaJobModel();
  try {
    await post(`${model.url}/v1/messages`, { model: "claude-sonnet-4-5", stream: false, messages: [] });
    const report = await post(`${model.url}/v1/messages`, {
      model: "claude-sonnet-4-5",
      stream: false,
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_rea_e2e",
          is_error: true,
          content: "Exit code 1 AssertionError: restricted sandbox leaked arbitrary internet egress",
        }],
      }],
    });
    assert.equal(report.stop_reason, "tool_use");
    assert.equal(report.content[0]?.id, "toolu_rea_fail_report");
    assert.match(report.content[0]?.input?.command ?? "", /REA_ACTOR_FAILED|emit_progress|base64/);

    const final = await post(`${model.url}/v1/messages`, {
      model: "claude-sonnet-4-5",
      stream: false,
      messages: [
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_rea_e2e",
            is_error: true,
            content: "Exit code 1 AssertionError: restricted sandbox leaked arbitrary internet egress",
          }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_rea_fail_report", content: "Exit code 1" }],
        },
      ],
    });
    assert.equal(final.stop_reason, "end_turn");
    assert.match(final.content[0]?.text ?? "", /refusing mark_job_done/);
  } finally {
    await model.close();
  }
});
