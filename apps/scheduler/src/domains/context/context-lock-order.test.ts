import assert from "node:assert/strict";
import test from "node:test";
import { beginEffect, buildAttemptState, updateAttemptContext, type AttemptDatabase } from "../job-attempt/index.js";
import { createJobRuntimeContext, persistJobRuntimeContext } from "./index.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const jobId = "context-lock-job";
const attemptId = "context-lock-attempt";
const context = () => createJobRuntimeContext({
  attemptId, adapterId: "pi", adapterVersion: "1", runtimeIdentity: `sha256:${"a".repeat(64)}`,
  compactionPolicy: "automatic", initialInput: "offline lock-order regression",
});

/** Offline row-lock model, not a PostgreSQL integration test.
 * SELECT FOR UPDATE and UPDATE take exclusive transaction-held row locks.
 * Wait-for cycles raise 40P01; commit publishes buffered writes, abort discards
 * them, and either outcome releases locks. Unknown SQL fails closed.
 * Only the two rows and gateway effect insertion relevant to #871 are modeled.
 */
function database(options: {
  missingJob?: boolean; attemptJobId?: string; status?: string; failJobWrite?: boolean;
  jobWriteErrors?: string[];
} = {}) {
  type Row = Record<string, unknown>;
  const jobWriteErrors = [...(options.jobWriteErrors ?? [])];
  let jobWriteAttempts = 0;
  const rows = new Map<string, Row>();
  if (!options.missingJob) rows.set("job", { id: jobId });
  rows.set("attempt", {
    id: attemptId, job_id: options.attemptJobId ?? jobId, status: options.status ?? "active",
    state_json: buildAttemptState({ attemptId, jobId: options.attemptJobId ?? jobId, attemptNo: 1 }),
  });
  const owners = new Map<string, number>();
  const waiting = new Map<number, number>();
  let changed = barrier();
  let nextId = 0;
  let beforeLock: (transaction: number, row: string) => void = () => {};
  async function lock(transaction: number, key: string) {
    beforeLock(transaction, key);
    while (owners.has(key) && owners.get(key) !== transaction) {
      const owner = owners.get(key)!;
      waiting.set(transaction, owner);
      let cursor: number | undefined = owner;
      while (cursor !== undefined && cursor !== transaction) cursor = waiting.get(cursor);
      if (cursor === transaction) {
        waiting.delete(transaction);
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      await changed.promise;
    }
    waiting.delete(transaction);
    owners.set(key, transaction);
  }
  const db = { begin: async (callback: (tx: AttemptDatabase) => Promise<unknown>) => {
    const transaction = ++nextId;
    const writes = new Map<string, Row>();
    const read = (key: string) => structuredClone(writes.get(key) ?? rows.get(key));
    const tx = Object.assign((input: TemplateStringsArray | Row, ...values: unknown[]) => {
      if (!Array.isArray(input)) return input;
      return (async () => {
        const query = input.join("?").replace(/\s+/gu, " ").trim();
        if (query.startsWith("SELECT id FROM jobs")) {
          assert.match(query, /FOR UPDATE$/u);
          assert.equal(values[0], jobId);
          await lock(transaction, "job");
          return rows.has("job") ? [read("job")] : [];
        }
        if (query.startsWith("SELECT * FROM job_attempts")) {
          assert.match(query, /FOR UPDATE$/u);
          assert.equal(values[0], attemptId);
          await lock(transaction, "attempt");
          return [read("attempt")];
        }
        if (query.startsWith("UPDATE job_attempts SET state_json")) {
          assert.match(query, /AND status = 'active'/u);
          await lock(transaction, "attempt");
          const row = read("attempt")!;
          if (row.status !== "active") return [];
          row.state_json = values[0];
          writes.set("attempt", row);
          return [read("attempt")];
        }
        if (query.startsWith("UPDATE jobs")) {
          await lock(transaction, "job");
          jobWriteAttempts += 1;
          const code = jobWriteErrors.shift();
          if (code) throw Object.assign(new Error("injected database conflict"), { code });
          if (options.failJobWrite) throw new Error("injected Job write failure");
          writes.set("job", { ...read("job"), context: values[0] });
          return [];
        }
        if (query.startsWith("INSERT INTO job_attempt_effects")) {
          assert.equal(owners.get("job"), transaction);
          assert.equal(owners.get("attempt"), transaction);
          writes.set("effect", values[0] as Row);
          return [{ id: "effect" }];
        }
        throw new Error(`unmodeled SQL: ${query}`);
      })();
    }, { json: (value: unknown) => value }) as unknown as AttemptDatabase;
    try {
      const result = await callback(tx);
      for (const [key, value] of writes) rows.set(key, structuredClone(value));
      return result;
    } finally {
      waiting.delete(transaction);
      for (const [key, owner] of owners) if (owner === transaction) owners.delete(key);
      const previous = changed;
      changed = barrier();
      previous.resolve();
    }
  } } as unknown as AttemptDatabase;
  return { db, rows, get jobWriteAttempts() { return jobWriteAttempts; },
    onLock: (hook: typeof beforeLock) => { beforeLock = hook; } };
}

async function race(persist: typeof persistJobRuntimeContext) {
  const fixture = database();
  const jobHeld = barrier();
  const contextWantsJob = barrier();
  fixture.onLock((transaction, row) => {
    if (transaction === 2 && row === "job") contextWantsJob.resolve();
  });
  // Gateway transaction boundary: admission holds Job before beginEffect.
  // No network request, token accounting or billing is performed by this model.
  const gateway = fixture.db.begin(async (raw) => {
    const tx = raw as unknown as AttemptDatabase;
    await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    jobHeld.resolve();
    await contextWantsJob.promise;
    return beginEffect(tx, attemptId, {
      effectId: "gateway:1", kind: "gateway_model_request", resourceIdentity: {}, intent: {},
    });
  });
  await jobHeld.promise;
  const persistResult = persist(fixture.db, jobId, context());
  const results = await Promise.allSettled([gateway, persistResult]);
  return { fixture, results };
}

test("negative control: former Attempt → Job order forms a 40P01 wait cycle", { timeout: 2000 }, async () => {
  const { results } = await race(async (db, id, state) => {
    await db.begin(async (raw) => {
      const tx = raw as unknown as AttemptDatabase;
      await updateAttemptContext(tx, attemptId, state);
      await tx`UPDATE jobs SET payload_json = ${tx.json(state as never)} WHERE id = ${id}`;
    });
  });
  assert.equal(results[0].status, "rejected");
  if (results[0].status === "rejected") assert.equal(results[0].reason.code, "40P01");
  assert.equal(results[1].status, "fulfilled");
});

test("context persistence and Gateway beginEffect complete with Job → Attempt order", { timeout: 2000 }, async () => {
  const { fixture, results } = await race(persistJobRuntimeContext);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.ok(fixture.rows.get("effect"));
  assert.deepEqual((fixture.rows.get("attempt")!.state_json as Record<string, unknown>).runtime_context,
    fixture.rows.get("job")!.context);
});

for (const [name, options, error] of [
  ["missing Job", { missingJob: true }, /CONTEXT_JOB_NOT_FOUND/u],
  ["foreign Attempt", { attemptJobId: "other-job" }, /CONTEXT_ATTEMPT_JOB_MISMATCH/u],
  ["terminal Attempt", { status: "succeeded" }, /CONTEXT_ATTEMPT_NOT_ACTIVE/u],
  ["Job write failure", { failJobWrite: true }, /injected Job write failure/u],
] as const) {
  test(`${name} leaves both context projections unchanged`, async () => {
    const fixture = database(options);
    const before = structuredClone(fixture.rows);
    await assert.rejects(persistJobRuntimeContext(fixture.db, jobId, context()), error);
    assert.deepEqual(fixture.rows, before);
  });
}

for (const code of ["40P01", "40001", "55P03"]) {
  test(`context retries rolled-back ${code} writes without partial projections`, async () => {
    const fixture = database({ jobWriteErrors: [code, code] });
    await persistJobRuntimeContext(fixture.db, jobId, context());
    assert.equal(fixture.jobWriteAttempts, 3);
    assert.deepEqual((fixture.rows.get("attempt")!.state_json as Record<string, unknown>).runtime_context,
      fixture.rows.get("job")!.context);
    assert.equal(fixture.rows.has("effect"), false, "context retries cannot create external effect intents");
  });
}

test("exhausted context conflicts preserve both projections and expose a stable error", async () => {
  const fixture = database({ jobWriteErrors: ["40P01", "40001", "55P03", "40P01"] });
  const before = structuredClone(fixture.rows);
  await assert.rejects(persistJobRuntimeContext(fixture.db, jobId, context()), {
    code: "DATABASE_CONFLICT_EXHAUSTED", attempts: 3,
  });
  assert.equal(fixture.jobWriteAttempts, 3);
  assert.deepEqual(fixture.rows, before);
});

test("non-conflict SQL errors never retry a context write", async () => {
  const fixture = database({ jobWriteErrors: ["23505"] });
  const before = structuredClone(fixture.rows);
  await assert.rejects(persistJobRuntimeContext(fixture.db, jobId, context()), { code: "23505" });
  assert.equal(fixture.jobWriteAttempts, 1);
  assert.deepEqual(fixture.rows, before);
});
