import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  selectLatestVerificationJob,
  selectLatestVerificationRepairJob,
  selectLatestVerificationRound,
} from "./finding-verification-result.js";

const job = (
  id: string,
  status: string,
  created_at: string,
  extra: { error?: string | null; finished_at?: string | null } = {},
) => ({
  id,
  status,
  error: extra.error ?? null,
  created_at,
  finished_at: extra.finished_at ?? null,
  started_at: null,
  type: "verify_finding",
});

test("verification repair uses the newest job, not the first historical failure", () => {
  const jobs = [
    job("old-fail", "failed", "2026-09-10T00:00:00.000Z", { error: "old boom", finished_at: "2026-09-10T00:01:00.000Z" }),
    job("new-ok", "succeeded", "2026-09-11T00:00:00.000Z", { finished_at: "2026-09-11T00:02:00.000Z" }),
  ];
  assert.equal(selectLatestVerificationJob(jobs)?.id, "new-ok");
  assert.equal(selectLatestVerificationRepairJob(jobs), undefined);

  const stillFailed = [
    ...jobs,
    job("newer-fail", "failed", "2026-09-11T01:00:00.000Z", { error: "new boom", finished_at: "2026-09-11T01:03:00.000Z" }),
  ];
  assert.equal(selectLatestVerificationRepairJob(stillFailed)?.id, "newer-fail");
  assert.equal(selectLatestVerificationRepairJob(stillFailed)?.error, "new boom");
});

test("latest verification round prefers the newest missing set", () => {
  const rounds = [
    { at: "2026-09-10T00:00:00.000Z", missing: ["old"], finished_at: "2026-09-10T00:01:00.000Z" },
    { at: "2026-09-11T00:00:00.000Z", missing: [], finished_at: "2026-09-11T00:02:00.000Z" },
  ];
  assert.deepEqual(selectLatestVerificationRound(rounds)?.missing, []);
  assert.deepEqual(
    selectLatestVerificationRound([
      ...rounds,
      { at: "2026-09-11T03:00:00.000Z", missing: ["fresh"], finished_at: null },
    ])?.missing,
    ["fresh"],
  );
});

test("Finding detail no longer binds RepairFeedback to the first failed verify job", () => {
  const panel = readFileSync(path.resolve(import.meta.dirname, "../FindingDetailPanel.tsx"), "utf8");
  assert.match(panel, /selectLatestVerificationRepairJob/);
  assert.match(panel, /selectLatestVerificationRound/);
  assert.doesNotMatch(panel, /verification_jobs\.find\(\(job\) => job\.error\)/);
});
