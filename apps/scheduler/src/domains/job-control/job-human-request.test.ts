import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentJobHumanRequest, projectJobHumanRequestPayload, redactJobHumanRequestText } from "./job-human-request.js";

const subject = { type: "platform_blocker", kind: "credential" };
const guidance = {
  question: "Which governed credential reference is available?",
  required_action: "Configure the reference within the existing authorized scope.",
  reply_instructions: "Reply with the reference without including any secret.",
  after_reply: "The Scheduler rechecks scope before deciding whether execution can continue.",
};

test("human detail projects only validated public fields without inventing historical guidance", () => {
  assert.deepEqual(projectJobHumanRequestPayload({ reason: "A credential reference is required.", subject }), {
    reason: "A credential reference is required.", subject,
  });
  assert.deepEqual(projectJobHumanRequestPayload({ reason: { raw: "invalid" }, subject: { ...subject, secret: "hidden" },
    guidance: { ...guidance, raw: "hidden" }, raw: "hidden", plan_basis: { secret: "hidden" } }), {});
  assert.deepEqual(projectJobHumanRequestPayload(null), {});
  assert.deepEqual(projectJobHumanRequestPayload([]), {});
  assert.deepEqual(projectJobHumanRequestPayload({ reason: "A credential reference is required.", subject, guidance,
    credential_provider: "raw-provider", token: "hidden" }), {
    reason: "A credential reference is required.", subject, guidance,
  });
});

test("human detail uses existing secret projection on validated reason and guidance", () => {
  const projected = projectJobHumanRequestPayload({ reason: 'Missing password="sensitive-example" for the authorized target.',
    subject, guidance: { ...guidance, required_action: 'Configure password="sensitive-example" through the governed UI.' } });
  assert.equal(JSON.stringify(projected).includes("sensitive-example"), false);
  assert.deepEqual(projected.subject, subject);
  assert.match(projected.reason!, /已保存密钥/);
});

test("human redaction covers quoted, unquoted and Authorization values without changing semantic structure", () => {
  for (const text of ['password="quoted-private-example"', "password=bare-private-example",
    "Authorization: Bearer bearer-private-example"]) {
    const reason = `Authorized task prerequisite: ${text}`;
    const source = { reason, subject, guidance: Object.fromEntries(Object.keys(guidance).map(key => [key, reason])),
      plan_basis: { outcome: "needs_human", objective_revision: 2, refs: ["fact-ref"] }, extra: [{ message: reason }] };
    const projected = projectJobHumanRequestPayload(source);
    assert.equal(JSON.stringify(projected).includes("private-example"), false);
    assert.deepEqual(projected.subject, subject);
    assert.deepEqual(Object.keys(projected.guidance!).sort(), Object.keys(guidance).sort());
    const redacted = redactJobHumanRequestText(source) as typeof source;
    assert.equal(JSON.stringify(redacted).includes("private-example"), false);
    assert.deepEqual(redacted.plan_basis, source.plan_basis);
    assert.deepEqual(redacted.subject, subject);
    assert.deepEqual(Object.keys(redacted), Object.keys(source));
    assert.equal(redacted.extra.length, 1);
    assert.equal(source.reason, reason);
  }
});

test("current human detail requires a live Job and its latest active uncancelled Attempt", () => {
  const attempt = { id: "latest", status: "active", cancel_requested: false };
  for (const status of ["running", "waiting_human"]) {
    assert.equal(isCurrentJobHumanRequest(status, attempt, "latest"), true);
    assert.equal(isCurrentJobHumanRequest(status, attempt, "older"), false);
    assert.equal(isCurrentJobHumanRequest(status, attempt, null), false);
    assert.equal(isCurrentJobHumanRequest(status, null, null), false);
    assert.equal(isCurrentJobHumanRequest(status, { ...attempt, status: "interrupted" }, "latest"), false);
    assert.equal(isCurrentJobHumanRequest(status, { ...attempt, cancel_requested: true }, "latest"), false);
  }
  for (const status of ["pending", "claimed", "provisioning", "failed", "timeout", "cancelled", "orphan", "succeeded"]) {
    assert.equal(isCurrentJobHumanRequest(status, attempt, "latest"), false);
  }
});
