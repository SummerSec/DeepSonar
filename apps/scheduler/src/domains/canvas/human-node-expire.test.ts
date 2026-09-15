import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyOpenHumanNodeExpiry } from "./human-node-expire-policy.js";

test("open human projections expire only when they have no live target or handler", () => {
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "open",
      jobId: "job-1",
      jobStatus: "waiting_human",
      body: { reason: "需要授权" },
    }),
    "keep",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "open",
      jobId: "job-1",
      jobStatus: "failed",
      body: { reason: "需要授权" },
    }),
    "job_not_waiting_human",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "open",
      jobId: "job-1",
      jobStatus: null,
      body: { reason: "需要授权" },
    }),
    "job_not_waiting_human",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "open",
      jobId: null,
      body: { kind: "verification_blocker", finding_id: "finding-1" },
      findingVerifyStatus: "needs_human",
    }),
    "keep",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "open",
      jobId: null,
      body: { kind: "verification_blocker", finding_id: "finding-1", reason: "max_hub_rounds" },
      findingVerifyStatus: "inconclusive",
    }),
    "finding_not_needs_human",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "open",
      jobId: null,
      body: { kind: "finding_comment", finding_id: "finding-1" },
    }),
    "keep",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "open",
      jobId: null,
      body: { message_id: "message-1" },
    }),
    "keep",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "open",
      jobId: null,
      body: { reason: "环境说明" },
    }),
    "dangling_human_node",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "ignored",
      jobId: "job-1",
      jobStatus: "failed",
      body: { resolution: "ignored" },
    }),
    "keep",
  );
  assert.equal(
    classifyOpenHumanNodeExpiry({
      status: "acknowledged",
      jobId: null,
      body: {},
    }),
    "keep",
  );
});

test("expire SQL keeps the three human lanes independent of Job timeout", () => {
  const expireSource = readFileSync(new URL("./human-node-expire.ts", import.meta.url), "utf8");
  const reaperSource = readFileSync(new URL("../../reaper.ts", import.meta.url), "utf8");
  assert.match(expireSource, /kind', ''\) <> 'finding_comment'/);
  assert.match(expireSource, /message_id' IS NULL/);
  assert.match(expireSource, /verify_status = 'needs_human'/);
  assert.match(expireSource, /j\.status = 'waiting_human'/);
  assert.doesNotMatch(expireSource, /UPDATE\s+jobs\s+SET\s+status/);
  assert.doesNotMatch(expireSource, /UPDATE\s+findings\s+SET/);
  assert.match(reaperSource, /reapWaitingHumanTimeout\(config\.timeouts\.waitingHumanSec\)/);
  assert.match(reaperSource, /reason: "human_timeout"/);
});
