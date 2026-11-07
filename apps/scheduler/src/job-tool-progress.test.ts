import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { persistJobToolProgress } from "./domains/canvas/job-tool-progress.js";

const input = { canvasId: "canvas", jobId: "job", action: "Read source" };
function database(options: { missingCanvas?: boolean; errors?: string[] } = {}) {
  const errors = [...(options.errors ?? [])];
  const traces: string[][] = [];
  let body: Record<string, unknown> = { summary: "Preserved", warning: "Preserved too" };
  const db = { begin: async (callback: (tx: unknown) => Promise<void>) => {
    const trace: string[] = [];
    traces.push(trace);
    let pending = body;
    const tx = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      trace.push(query);
      if (query.startsWith("SELECT id FROM canvases")) {
        assert.match(query, /WHERE id = \? FOR UPDATE$/);
        assert.deepEqual(values, [input.canvasId]);
        return options.missingCanvas ? [] : [{ id: input.canvasId }];
      }
      assert.equal(trace.length, 2, "only the Canvas lock may precede the node write");
      assert.match(query, /^UPDATE canvas_nodes SET body_json = body_json \|\|/);
      assert.match(query, /WHERE canvas_id = \? AND job_id = \? AND node_type = 'job'$/);
      assert.deepEqual(values.slice(1), [input.canvasId, input.jobId]);
      pending = { ...body, ...values[0] as Record<string, unknown> };
      const code = errors.shift();
      if (code) throw Object.assign(new Error("injected SQL failure"), { code });
      return [];
    }, { json: (value: unknown) => value });
    await callback(tx);
    body = pending;
  } } as unknown as Parameters<typeof persistJobToolProgress>[0];
  return { db, traces, body: () => body };
}

test("tool progress locks Canvas first and changes only the scoped projection", async () => {
  const fixture = database();
  await persistJobToolProgress(fixture.db, input);
  assert.deepEqual(fixture.body(), { summary: "Preserved", warning: "Preserved too",
    last_progress: { message: input.action, kind: "tool" } });
  assert.equal(fixture.traces.length, 1);
});

test("missing Canvas never falls back to a Job-only node write", async () => {
  const absent = database();
  await persistJobToolProgress(absent.db, { ...input, canvasId: null });
  assert.deepEqual(absent.traces, []);
  const removed = database({ missingCanvas: true });
  await persistJobToolProgress(removed.db, input);
  assert.equal(removed.traces[0].length, 1);
  assert.equal(removed.body().last_progress, undefined);
});

for (const code of ["40P01", "40001", "55P03"]) {
  test(`tool progress retries only the rolled-back ${code} database transaction`, async () => {
    const fixture = database({ errors: [code, code] });
    await persistJobToolProgress(fixture.db, input);
    assert.equal(fixture.traces.length, 3);
    assert.ok(fixture.traces.every(trace => trace.length === 2));
    assert.deepEqual(fixture.body().last_progress, { message: input.action, kind: "tool" });
  });
}

test("exhausted conflicts and non-conflict failures leave the projection unchanged", async () => {
  const exhausted = database({ errors: ["40P01", "40P01", "40P01"] });
  await assert.rejects(persistJobToolProgress(exhausted.db, input), { code: "DATABASE_CONFLICT_EXHAUSTED", attempts: 3 });
  assert.equal(exhausted.traces.length, 3);
  assert.equal(exhausted.body().last_progress, undefined);
  for (const code of ["23505", "25P02"]) {
    const fixture = database({ errors: [code] });
    await assert.rejects(persistJobToolProgress(fixture.db, input), { code });
    assert.equal(fixture.traces.length, 1);
    assert.equal(fixture.body().last_progress, undefined);
  }
});

test("executor routes throttled progress through the Canvas-first database writer", () => {
  const source = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
  assert.match(source, /if \(now - lastActionPush > 1500\) \{\s*lastActionPush = now;\s*void persistJobToolProgress\(sql, \{ canvasId, jobId, action \}\)\.catch/);
  assert.doesNotMatch(source, /UPDATE canvas_nodes SET body_json = body_json \|\|/);
});
