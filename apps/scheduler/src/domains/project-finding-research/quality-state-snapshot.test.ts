import test from "node:test";
import assert from "node:assert/strict";
import { withQualityHead, loadQualityHistory, type QualityStateDb } from "./quality-state-store.js";
import { QUALITY_INPUT_BYTES, QUALITY_TRACE_LIMIT } from "./quality-contract.js";

const project = "10000000-0000-4000-8000-000000000001";
const protocol = "10000000-0000-4000-8000-000000000002";
const record = "10000000-0000-4000-8000-000000000003";
// SQL query/argument behavior only; these mocks are not MVCC or PostgreSQL proof.
for (const isolation of [undefined, "repeatable_read"] as const) {
  test(`head locks retain order with ${isolation ?? "default"} transaction isolation`, async () => {
    const order: string[] = [];
    const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      assert.match(text, /FOR UPDATE/u);
      if (text.includes("project_finding_quality_current")) {
        assert.deepEqual(values, [project]); order.push("current");
        return [{ project_id: project, version: "0" }];
      }
      assert.match(text, /project_finding_quality_heads/u);
      assert.deepEqual(values, [project, protocol]); order.push("head");
      return [{ project_id: project, protocol_id: protocol, version: "9007199254740994", phase: "registered",
        latest_record_id: record, freeze_record_id: null, declaration_record_id: null, first_access_record_id: null,
        dataset_record_id: null, evaluation_record_id: null, review_record_id: null, revocation_record_id: null,
        updated_at: new Date("2026-11-01T00:00:00Z") }];
    };
    const db = Object.assign(tag, { begin: async (...args: unknown[]) => {
      assert.equal(args.length, isolation ? 2 : 1);
      if (isolation) assert.equal(args[0], "isolation level repeatable read");
      order.push("begin");
      return (args.at(-1) as (tx: unknown) => Promise<unknown>)(db);
    } }) as unknown as QualityStateDb;
    const result = await withQualityHead(project, protocol, "9007199254740994", async (_tx, head) => {
      order.push("callback"); return head.version;
    }, db, isolation ? { isolationLevel: isolation } : undefined);
    assert.equal(result, "9007199254740994");
    assert.deepEqual(order, ["begin", "current", "head", "callback"]);
  });
}

for (const flag of [false, true, undefined, "false"] as const) {
  test(`history byte-bound SQL envelope handles overflow flag ${String(flag)}`, async () => {
    let calls = 0;
    const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls++;
      const text = strings.join("?").replace(/\s+/gu, " ");
      assert.deepEqual(values, [project, QUALITY_TRACE_LIMIT + 1, project, QUALITY_TRACE_LIMIT + 1, QUALITY_INPUT_BYTES]);
      assert.match(text, /WITH protocols AS MATERIALIZED/u);
      assert.match(text, /receipts AS MATERIALIZED/u);
      assert.match(text, /sum\(octet_length\(to_jsonb\(protocols\)::text\)\)/u);
      assert.match(text, /sum\(octet_length\(to_jsonb\(receipts\)::text\)\)/u);
      assert.match(text, /CASE WHEN history_overflow THEN/u);
      return [{ protocol_rows: [], records: [], history_overflow: flag }];
    }) as unknown as QualityStateDb;
    if (flag === false) assert.deepEqual(await loadQualityHistory(db, project), { protocol_rows: [], records: [] });
    else await assert.rejects(loadQualityHistory(db, project), { code: flag === true ? "QUALITY_HISTORY_LIMIT" : "QUALITY_HISTORY_INVALID" });
    assert.equal(calls, 1);
  });
}

test("internal transaction options cannot supply arbitrary isolation SQL", async () => {
  const db = { begin: () => assert.fail("invalid options must fail before opening SQL") } as unknown as QualityStateDb;
  await assert.rejects(withQualityHead(project, protocol, "0", async () => 1, db,
    { isolationLevel: "serializable; SELECT 1" } as never), { code: "QUALITY_TX_ISOLATION_INVALID" });
});
