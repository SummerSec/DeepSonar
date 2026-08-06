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
 * Phase-1 inventory of the intentionally retained direct Job status writers.
 * Lifecycle-owned callers now route through domains/job-lifecycle/application;
 * semantic-human is owned by event-ingestion; finalize and priority-drain
 * remain in core.ts until their convergence slices are moved.
 */
const JOB_STATE_WRITE_INVENTORY: readonly JobStateWriteEntry[] = [
  {
    id: "event-ingestion.semantic-human",
    file: "domains/event-ingestion/side-effects.ts",
    targets: ["waiting_human"],
    purpose: "request_human moves a running Job into the human gate",
    pattern:
      /UPDATE\s+jobs\s+SET\s+status\s*=\s*'waiting_human'[\s\S]*?WHERE\s+id\s*=\s*\$\{jobId\}\s+AND\s+status\s*=\s*'running'/,
  },
  {
    id: "core.finalize-running-terminal",
    file: "core.ts",
    targets: ["succeeded", "failed"],
    purpose: "finalizeJob performs the guarded running-to-terminal CAS",
    pattern:
      /UPDATE\s+jobs\s+SET\s+status\s*=\s*\$\{status\}[\s\S]*?WHERE\s+id\s*=\s*\$\{jobId\}\s+AND\s+status\s*=\s*'running'/,
  },
  {
    id: "core.drain-non-gate-verify",
    file: "core.ts",
    targets: ["cancelled"],
    purpose: "priority drain cancels pending non-gate Verify Jobs",
    pattern:
      /UPDATE\s+jobs\s+j\s+SET\s+status\s*=\s*'cancelled'[\s\S]*?FROM\s+findings\s+f[\s\S]*?j\.status\s*=\s*'pending'/,
  },
] as const;

const SOURCE_ROOT = new URL(".", import.meta.url);
const CANONICAL_LIFECYCLE_ADAPTER = "domains/job-lifecycle/application.ts";

function productionSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: URL, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, directory), relativePath);
        continue;
      }
      if (
        entry.isFile() &&
        /\.ts$/i.test(entry.name) &&
        !/\.test\.ts$/i.test(entry.name) &&
        relativePath !== CANONICAL_LIFECYCLE_ADAPTER
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

function skipQuotedString(source: string, start: number, quote: "'" | '"'): number {
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) return cursor;
  }
  return source.length;
}

function skipTemplateLiteral(source: string, start: number): number {
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "`") return cursor;
    if (source[cursor] === "$" && source[cursor + 1] === "{") {
      cursor = findInterpolationEnd(source, cursor + 2);
    }
  }
  return source.length;
}

function findInterpolationEnd(source: string, start: number): number {
  let depth = 1;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      cursor = skipQuotedString(source, cursor, character);
      continue;
    }
    if (character === "`") {
      cursor = skipTemplateLiteral(source, cursor);
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return source.length;
}

function findTemplateLiteralEnd(source: string, start: number): number {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === "$" && source[cursor + 1] === "{") {
      cursor = findInterpolationEnd(source, cursor + 2);
      continue;
    }
    if (character === "`") return cursor;
  }
  return source.length;
}

function directStatusUpdateSegments(source: string): { index: number; text: string }[] {
  const starts = [...source.matchAll(/\bUPDATE\s+(?:(?:[a-z_][a-z0-9_$]*)\.)?jobs\b/gi)]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);
  return starts.flatMap((index) => {
    const statementEnd = findTemplateLiteralEnd(source, index);
    const text = source.slice(index, statementEnd);
    const setClause =
      /UPDATE\s+(?:(?:[a-z_][a-z0-9_$]*)\.)?jobs(?:\s+(?:AS\s+)?[a-z_][a-z0-9_$]*)?\s+SET(?<set>[\s\S]*?)(?:\bWHERE\b|$)/i.exec(
        text,
      );
    const setText = setClause?.groups?.set ?? "";
    return /\bstatus\s*=/.test(setText) || /\bSET\s+\$\{/.test(text) ? [{ index, text }] : [];
  });
}

test("direct status scanner handles qualified, aliased, nested, and unguarded SQL", () => {
  const source = [
    "await sql`UPDATE public.jobs AS j SET status = 'succeeded'`",
    "await sql`UPDATE jobs AS j SET status = 'failed'`",
    "await sql`UPDATE jobs SET status = 'timeout', error = ${`nested ${label}`}`",
    "await sql`UPDATE jobs SET payload_json = ${payload}`",
  ].join("\n");
  const segments = directStatusUpdateSegments(source);
  assert.deepEqual(
    segments.map((segment) => segment.index),
    ["UPDATE public.jobs", "UPDATE jobs AS j", "UPDATE jobs SET status = 'timeout'"].map((marker) =>
      source.indexOf(marker),
    ),
  );
  assert.equal(directStatusUpdateSegments("await sql`UPDATE jobs SET ${db(sets)}`").length, 1);
});

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
  const dynamicSetFiles = productionSourceFiles().filter((file) =>
    directStatusUpdateSegments(sourceFor(file)).some((segment) => /\bSET\s+\$\{/.test(segment.text)),
  );
  assert.deepEqual(dynamicSetFiles, [], "generic dynamic jobs SET must remain in the canonical lifecycle adapter");
});

test("inventory paths point to production Scheduler modules", () => {
  const productionFiles = new Set(productionSourceFiles());
  for (const entry of JOB_STATE_WRITE_INVENTORY) {
    assert.ok(productionFiles.has(entry.file), `${entry.file} must be a production Scheduler module`);
  }
});
