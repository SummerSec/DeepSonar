import assert from "node:assert/strict";
import test from "node:test";
import { RELATION_PAIR_LIMIT, selectStrongRelationCandidates } from "./strong-candidate-selector.js";

// Synthetic engineering attestations only: not human quality labels, external
// authority certification, a tuning/holdout set, or publication clearance.
type Db = Parameters<typeof selectStrongRelationCandidates>[0];
type Input = Parameters<typeof selectStrongRelationCandidates>[1];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input: Input = { projectId: id(1), findingId: id(1000),
  rootCause: { status: "valid", identity_digest: `sha256:${"a".repeat(64)}` } };
function stub(rows: Array<{ finding_id: string }> = []) {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join("?").replace(/\s+/gu, " ").trim(), values });
    return rows.slice(0, Number(values.at(-1)));
  }) as unknown as Db;
  return { db, calls };
}

test("unusable root skips SQL rather than broadening the candidate corpus", async () => {
  for (const status of ["missing", "stale", "revoked", "conflict"] as const) {
    const s = stub();
    const result = await selectStrongRelationCandidates(s.db, { ...input,
      rootCause: { ...input.rootCause, status } });
    assert.deepEqual(result, { peerIds: [], observedCount: 0, truncated: false, countKind: "exact" });
    assert.equal(s.calls.length, 0);
  }
  for (const identity_digest of [null, ""]) {
    const s = stub();
    await selectStrongRelationCandidates(s.db, { ...input, rootCause: { status: "valid", identity_digest } });
    assert.equal(s.calls.length, 0);
  }
});
test("deployed SQL preserves canonical project/source/revision guards and SQL now()", async () => {
  const s = stub();
  await selectStrongRelationCandidates(s.db, input);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].values, [input.projectId, input.rootCause.identity_digest, input.findingId, 257]);
  const expected = `SELECT DISTINCT m.finding_id
    FROM project_finding_identity_mappings m
    JOIN project_finding_identity_sources s
      ON s.project_id = m.project_id AND s.source_id = m.source_id
     AND s.finding_id = m.finding_id
    JOIN project_finding_identity_source_revisions r
      ON r.project_id = m.project_id AND r.source_id = m.source_id
     AND r.finding_id = m.finding_id AND r.revision = m.source_revision
    WHERE m.project_id = ?::uuid AND m.field = 'root_cause'
      AND r.identity_fields_json ->> 'root_cause' = ?
      AND m.revoked_at IS NULL AND s.revoked_at IS NULL
      AND s.current_revision = m.source_revision AND r.freshness_until > now()
      AND m.finding_id > ?::uuid
    ORDER BY m.finding_id LIMIT ?`.replace(/\s+/gu, " " ).trim();
  assert.equal(s.calls[0].query, expected, "No lexical/top25/label/split/job or historical time filters");
});

test("257 sentinel bounds observed trace and first256 execution without inventing exact totals", async () => {
  assert.equal(RELATION_PAIR_LIMIT, 256);
  for (const size of [0, 1, 255, 256, 257, 300]) {
    const rows = Array.from({ length: size }, (_, i) => ({ finding_id: id(1001 + i) }));
    const s = stub(rows);
    const result = await selectStrongRelationCandidates(s.db, input);
    assert.deepEqual(result.peerIds, rows.slice(0, 256).map((row) => row.finding_id));
    assert.equal(result.observedCount, Math.min(size, 257));
    assert.equal(result.truncated, size > 256);
    assert.equal(result.countKind, size > 256 ? "lower_bound" : "exact");
    assert.equal(result.peerIds.includes(id(1257)), false, "sentinel is not executed");
    assert.equal(s.calls.length, 1, "no full count/rank or peer queries");
  }
});

test("SQL failure propagates without lexical or unscoped fallback", async () => {
  const failure = new Error("synthetic selector SQL failure");
  const db = (async () => { throw failure; }) as unknown as Db;
  await assert.rejects(selectStrongRelationCandidates(db, input), (error) => error === failure);
});
