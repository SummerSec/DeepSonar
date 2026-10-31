import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("terminal paths revoke gateway and platform capability tokens together", async () => {
  const cases: Array<{ file: string; gateway: string; capability: string }> = [
    {
      file: "./core.ts",
      gateway: "revokeJobTokens(jobId, `job_${status}`)",
      capability: "revokeJobCapabilityTokens(jobId, `job_${status}`)",
    },
    {
      file: "./reaper.ts",
      gateway: 'revokeJobTokens(jobId, "reaper")',
      capability: 'revokeJobCapabilityTokens(jobId, "reaper")',
    },
    {
      file: "./reconcile.ts",
      gateway: 'revokeJobTokens(jobId, "orphan_reconcile")',
      capability: 'revokeJobCapabilityTokens(jobId, "orphan_reconcile")',
    },
    {
      file: "./domains/job-control/routes.ts",
      gateway: 'revokeJobTokens(id, "cancelled")',
      capability: 'revokeJobCapabilityTokens(id, "cancelled")',
    },
    {
      file: "./domains/job-control/routes.ts",
      gateway: 'revokeJobTokens(jobId, "cancelled")',
      capability: 'revokeJobCapabilityTokens(jobId, "cancelled")',
    },
    {
      file: "./domains/project-task/routes.ts",
      gateway: 'revokeJobTokens(id, "cancelled")',
      capability: 'revokeJobCapabilityTokens(id, "cancelled")',
    },
    {
      file: "./domains/runtime-image/routes.ts",
      gateway: 'revokeJobTokens(job.id as string, "runtime_image_revoked")',
      capability: 'revokeJobCapabilityTokens(job.id as string, "runtime_image_revoked")',
    },
    {
      file: "./dispatcher.ts",
      gateway: 'revokeJobTokens(jobId, "dispatcher_cleanup")',
      capability: "revokeJobCapabilityTokens(jobId)",
    },
  ];

  for (const item of cases) {
    const body = await source(item.file);
    assert.ok(body.includes(item.gateway), `${item.file} must keep ${item.gateway}`);
    assert.ok(body.includes(item.capability), `${item.file} must pair ${item.capability}`);
  }
});

test("priority-drain cancellation revokes platform capability tokens", async () => {
  const body = await source("./core.ts");
  assert.ok(body.includes("UPDATE jobs j SET status = 'cancelled'"));
  assert.ok(body.includes('revokeJobCapabilityTokens(row.id as string, "drain-priority")'));
});

test("dispatcher finally revokes gateway and platform capability tokens together", async () => {
  const body = await source("./dispatcher.ts");
  const finallyBlock = body.match(/\} finally \{[\s\S]*?\n  \}\n\}/);
  assert.ok(finallyBlock, "dispatcher attempt finally block must exist");
  assert.ok(
    finallyBlock[0].includes('revokeJobTokens(jobId, "dispatcher_cleanup")'),
    "dispatcher finally must revoke model gateway tokens after executor failures",
  );
  assert.ok(
    finallyBlock[0].includes("revokeJobCapabilityTokens(jobId)"),
    "dispatcher finally must keep platform capability token revocation",
  );
});
