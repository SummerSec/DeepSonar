import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

type JobStateWriteEntry = {
  id: string;
  file: string;
  targets: readonly string[];
  purpose: string;
  pattern: RegExp;
};

/**
 * Phase-0 inventory of the legacy direct Job status writers.  The IDs are
 * semantic boundaries, not source line numbers.  A later bounded-context
 * slice may move an operation, but it must either preserve the operation's
 * guard or update this characterization with an intentional review.
 */
const JOB_STATE_WRITE_INVENTORY: readonly JobStateWriteEntry[] = [
  {
    id: "core.semantic-human",
    file: "core.ts",
    targets: ["waiting_human"],
    purpose: "request_human moves a running Job into the human gate",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'waiting_human'[\s\S]*?WHERE\s+id\s*=\s*\$\{jobId\}\s+AND\s+status\s*=\s*'running'/,
  },
  {
    id: "core.finalize-running-terminal",
    file: "core.ts",
    targets: ["succeeded", "failed"],
    purpose: "finalizeJob performs the guarded running-to-terminal CAS",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*\$\{status\}[\s\S]*?WHERE\s+id\s*=\s*\$\{jobId\}\s+AND\s+status\s*=\s*'running'/,
  },
  {
    id: "core.drain-non-gate-verify",
    file: "core.ts",
    targets: ["cancelled"],
    purpose: "priority drain cancels pending non-gate Verify Jobs",
    pattern: /UPDATE\s+jobs\s+j\s+SET\s+status\s*=\s*'cancelled'[\s\S]*?FROM\s+findings\s+f[\s\S]*?j\.status\s*=\s*'pending'/,
  },
  {
    id: "dispatcher.claim",
    file: "dispatcher.ts",
    targets: ["claimed"],
    purpose: "dispatcher claims a pending Job",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'claimed'[\s\S]*?WHERE\s+id\s*=\s*\$\{job\.id\s+as\s+string\}[\s\S]*?status\s*=\s*'pending'/,
  },
  {
    id: "dispatcher.execution-failure",
    file: "dispatcher.ts",
    targets: ["failed"],
    purpose: "dispatcher exception path fails only active claim/provision/run Jobs",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'failed'[\s\S]*?WHERE\s+id\s*=\s*\$\{jobId\}[\s\S]*?status\s+IN\s*\(\s*'claimed'\s*,\s*'provisioning'\s*,\s*'running'\s*\)/,
  },
  {
    id: "reaper.execution-timeout",
    file: "reaper.ts",
    targets: ["timeout"],
    purpose: "Reaper marks over-time active Jobs as timeout",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'timeout'[\s\S]*?WHERE\s+status\s+IN\s*\(\s*'claimed'\s*,\s*'provisioning'\s*,\s*'running'\s*\)[\s\S]*?started_at\s+IS\s+NOT\s+NULL/,
  },
  {
    id: "reaper.provision-timeout",
    file: "reaper.ts",
    targets: ["failed"],
    purpose: "Reaper fails Jobs stuck in claim/provisioning",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'failed'[\s\S]*?WHERE\s+status\s+IN\s*\(\s*'claimed'\s*,\s*'provisioning'\s*\)[\s\S]*?claimed_at\s+IS\s+NOT\s+NULL/,
  },
  {
    id: "reaper.lease-orphan",
    file: "reaper.ts",
    targets: ["orphan"],
    purpose: "Reaper marks expired running leases orphan",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'orphan'[\s\S]*?WHERE\s+status\s*=\s*'running'[\s\S]*?lease_expires_at\s+IS\s+NOT\s+NULL/,
  },
  {
    id: "reconcile.provision-requeue",
    file: "reconcile.ts",
    targets: ["pending"],
    purpose: "boot reconcile requeues Jobs interrupted during provisioning",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'pending'[\s\S]*?WHERE\s+status\s+IN\s*\(\s*'claimed'\s*,\s*'provisioning'\s*\)/,
  },
  {
    id: "reconcile.running-orphan",
    file: "reconcile.ts",
    targets: ["orphan"],
    purpose: "boot reconcile closes Jobs that were running at scheduler restart",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'orphan'[\s\S]*?WHERE\s+status\s*=\s*'running'/,
  },
  {
    id: "routes.archive-cancel-active",
    file: "routes.ts",
    targets: ["cancelled"],
    purpose: "task archive/delete cancels active Jobs before destructive cleanup",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'cancelled'[\s\S]*?COALESCE\(error,\s*'task archived\/deleted'\)[\s\S]*?WHERE\s+id\s*=\s*\$\{id\}[\s\S]*?status\s+IN\s*\(\s*'pending'/,
  },
  {
    id: "routes.runtime-image-revocation",
    file: "routes.ts",
    targets: ["cancelled"],
    purpose: "revoking a runtime image cancels Jobs frozen to that image",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'cancelled'[\s\S]*?agent_snapshot_json\s+#>>\s*'\{runtime_image,runtime_image_version_id\}'[\s\S]*?status\s+IN\s*\(\s*'pending'/,
  },
  {
    id: "routes.job-cancel",
    file: "routes.ts",
    targets: ["cancelled"],
    purpose: "single-job cancel route performs an active-state CAS",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'cancelled'[\s\S]*?lease_expires_at\s*=\s*NULL[\s\S]*?WHERE\s+id\s*=\s*\$\{id\}[\s\S]*?status\s+IN\s*\(\s*'pending'/,
  },
  {
    id: "routes.canvas-cancel-active",
    file: "routes.ts",
    targets: ["cancelled"],
    purpose: "canvas cancel-active route cancels each still-active Job",
    pattern: /UPDATE\s+jobs\s+SET\s+status\s*=\s*'cancelled'[\s\S]*?WHERE\s+id\s*=\s*\$\{jobId\}[\s\S]*?status\s+IN\s*\(\s*'pending'/,
  },
] as const;

const SOURCE_ROOT = new URL(".", import.meta.url);
const CANONICAL_LIFECYCLE_ADAPTER = "domains/job-lifecycle/application.ts";

function isTestFixturePath(relativePath: string): boolean {
  const pathParts = relativePath.split("/");
  return pathParts.some((part) => /^(?:__fixtures__|fixtures|test-fixtures)$/i.test(part)) || /\.fixture\.ts$/i.test(relativePath);
}

function productionSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: URL, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isTestFixturePath(relativePath)) walk(new URL(`${entry.name}/`, directory), relativePath);
        continue;
      }
      if (
        entry.isFile() &&
        /\.ts$/i.test(entry.name) &&
        !/\.test\.ts$/i.test(entry.name) &&
        relativePath !== CANONICAL_LIFECYCLE_ADAPTER &&
        !isTestFixturePath(relativePath)
      ) {
        files.push(relativePath);
      }
    }
  };
  walk(SOURCE_ROOT, "");
  return files.sort();
}

function sourceFor(file: string): string {
  return readFileSync(new URL(file, SOURCE_ROOT), "utf8");
}

function directStatusUpdateSegments(source: string): { index: number; text: string }[] {
  const starts = [...source.matchAll(/UPDATE\s+jobs\b/gi)]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);
  return starts
    .map((index, offset) => {
      // Production SQL templates close with ``;``.  Using that semantic
      // statement boundary avoids matching an identifier from the next
      // handler (or from a nested JavaScript template interpolation).
      const statementEnd = source.indexOf("`;", index);
      return {
        index,
        text: source.slice(index, statementEnd >= 0 ? statementEnd + 2 : starts[offset + 1] ?? source.length),
      };
    })
    .filter((segment) => {
      const setClause = /UPDATE\s+jobs(?:\s+[a-z][a-z0-9_]*)?\s+SET(?<set>[\s\S]*?)\bWHERE\b/i.exec(segment.text);
      return /\bstatus\s*=/.test(setClause?.groups?.set ?? "");
    });
}

test("direct Job status writers stay enumerated by semantic bounded-context inventory", () => {
  const discoveredFiles: string[] = [];
  for (const file of productionSourceFiles()) {
    const source = sourceFor(file);
    const entries = JOB_STATE_WRITE_INVENTORY.filter((entry) => entry.file === file);
    const segments = directStatusUpdateSegments(source);
    if (segments.length === 0) continue;
    discoveredFiles.push(file);
    const expectedIndexes: number[] = [];
    for (const entry of entries) {
      const matches = segments.filter((segment) => entry.pattern.test(segment.text));
      assert.equal(matches.length, 1, `${entry.id} must identify one status write in ${file}`);
      assert.ok(entry.targets.length > 0, `${entry.id} must declare a target status`);
      assert.ok(entry.purpose.length > 0, `${entry.id} must explain its boundary`);
      expectedIndexes.push(matches[0].index);
    }
    assert.deepEqual(
      segments.map((segment) => segment.index).sort((a, b) => a - b),
      expectedIndexes.sort((a, b) => a - b),
      `${file} has an unclassified or missing direct Job status writer`,
    );
  }
  assert.deepEqual(
    [...new Set(JOB_STATE_WRITE_INVENTORY.map((entry) => entry.file))].sort(),
    discoveredFiles.sort(),
    "inventory files must cover every production direct Job status writer",
  );
  const finalizeEntry = JOB_STATE_WRITE_INVENTORY.find((entry) => entry.id === "core.finalize-running-terminal");
  assert.ok(finalizeEntry);
  const finalizeSignature = sourceFor("core.ts").match(
    /export\s+async\s+function\s+finalizeJob\([\s\S]*?\bstatus:\s*((?:"[^"]+"\s*\|\s*)+"[^"]+")/,
  );
  assert.ok(finalizeSignature, "finalizeJob must keep an explicit status union");
  const finalizeStatuses = [...finalizeSignature[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    finalizeEntry.targets,
    finalizeStatuses,
    "finalize inventory targets must match the finalizeJob status union",
  );
});

test("job-lifecycle SQL seam remains the sole generic transition adapter", () => {
  const source = sourceFor("domains/job-lifecycle/application.ts");
  assert.match(source, /UPDATE\s+jobs\s+SET\s+\$\{db\(sets\)\}/);
  assert.match(source, /WHERE\s+id\s*=\s*\$\{jobId\}\s+AND\s+status\s*=\s+ANY\(\$\{allowedFrom\}\)/);
  assert.match(source, /planJobTransition\(to, patch\)/);
});

test("inventory paths point to production Scheduler modules", () => {
  const productionFiles = new Set(productionSourceFiles());
  for (const entry of JOB_STATE_WRITE_INVENTORY) {
    assert.ok(productionFiles.has(entry.file), `${entry.file} must be a production Scheduler module`);
  }
});
