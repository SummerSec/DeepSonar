import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DB_CONFLICT_MAX_ATTEMPTS,
  DatabaseConflictExhaustedError,
  isRetryableDatabaseConflict,
  withDatabaseConflictRetry,
  withOperationConflictRetry,
} from "./db-conflict-retry.js";

const conflict = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

test("only deadlock, serialization and lock-timeout errors are retryable", () => {
  for (const code of ["40P01", "40001", "55P03"]) {
    assert.equal(isRetryableDatabaseConflict(conflict(code)), true, `${code} must be retryable`);
  }
  for (const code of ["23505", "23503", "25P02", "42P01", "57014", "08006"]) {
    assert.equal(isRetryableDatabaseConflict(conflict(code)), false, `${code} must not be retried`);
  }
  assert.equal(isRetryableDatabaseConflict(null), false);
  assert.equal(isRetryableDatabaseConflict(new Error("plain")), false);
  // postgres.js occasionally wraps the driver error.
  assert.equal(isRetryableDatabaseConflict({ code: "XX000", cause: conflict("40P01") }), true);
});

test("a recoverable conflict is retried and the successful result is returned", async () => {
  const delays: number[] = [];
  const conflicts: number[] = [];
  let calls = 0;
  const result = await withDatabaseConflictRetry(async (attempt) => {
    calls += 1;
    if (attempt < 3) throw conflict("40P01");
    return `ok-${attempt}`;
  }, {
    sleep: async (ms) => { delays.push(ms); },
    onConflict: (_error, attempt) => { conflicts.push(attempt); },
  });
  assert.equal(result, "ok-3");
  assert.equal(calls, 3);
  assert.deepEqual(conflicts, [1, 2], "each retried conflict is reported");
  assert.deepEqual(delays, [25, 50], "backoff doubles between attempts");
});

test("a non-conflict error is thrown immediately without retrying", async () => {
  let calls = 0;
  await assert.rejects(
    () => withDatabaseConflictRetry(async () => {
      calls += 1;
      throw conflict("23505");
    }, { sleep: async () => {} }),
    (error: unknown) => (error as { code?: string }).code === "23505",
  );
  assert.equal(calls, 1, "unique-violation must not be retried");
});

test("exhaustion surfaces a stable code instead of a bare driver error", async () => {
  let calls = 0;
  await assert.rejects(
    () => withDatabaseConflictRetry(async () => {
      calls += 1;
      throw conflict("40P01");
    }, { sleep: async () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseConflictExhaustedError);
      assert.equal(error.code, "DATABASE_CONFLICT_EXHAUSTED");
      assert.equal(error.attempts, DB_CONFLICT_MAX_ATTEMPTS);
      return true;
    },
  );
  assert.equal(calls, DB_CONFLICT_MAX_ATTEMPTS, "retries are bounded, not unbounded");
});

test("the attempt index lets the transaction re-read state on each retry", async () => {
  const seen: number[] = [];
  await withDatabaseConflictRetry(async (attempt) => {
    seen.push(attempt);
    if (attempt === 1) throw conflict("40001");
    return attempt;
  }, { sleep: async () => {} });
  assert.deepEqual(seen, [1, 2]);
});

// #945: deadlocks on platform-owned transactions used to fail the whole Job.
test("#945 the operation wrapper retries conflicts and returns the committed result", async () => {
  const conflicts: number[] = [];
  let calls = 0;
  const result = await withOperationConflictRetry("unit_probe", async (attempt) => {
    calls += 1;
    if (attempt < 2) throw conflict("40P01");
    return "committed";
  }, {
    sleep: async () => {},
    onConflict: (_error, attempt) => { conflicts.push(attempt); },
  });
  assert.equal(result, "committed");
  assert.equal(calls, 2);
  assert.deepEqual(conflicts, [1], "caller-visible conflicts still fire for extra context");
});

test("#945 the operation wrapper never retries a non-conflict error", async () => {
  let calls = 0;
  await assert.rejects(
    () => withOperationConflictRetry("unit_probe", async () => {
      calls += 1;
      throw conflict("23505");
    }, { sleep: async () => {} }),
    (error: unknown) => (error as { code?: string }).code === "23505",
  );
  assert.equal(calls, 1);
});

test("#945 exhaustion surfaces DATABASE_CONFLICT_EXHAUSTED, not a driver error", async () => {
  await assert.rejects(
    () => withOperationConflictRetry("unit_probe", async () => {
      throw conflict("40001");
    }, { sleep: async () => {} }),
    (error: unknown) => error instanceof DatabaseConflictExhaustedError
      && error.code === "DATABASE_CONFLICT_EXHAUSTED",
  );
});

test("#945 the Job-facing transaction entrances stay wrapped", () => {
  const core = readFileSync(new URL("./core.ts", import.meta.url), "utf8");
  const reconcile = readFileSync(new URL("./reconcile.ts", import.meta.url), "utf8");
  for (const [source, operation] of [
    [core, "preflight_deferred_side_effects"],
    [core, "create_job"],
    [core, "ensure_canvas_for_task"],
    [core, "recover_verify_terminal"],
    [reconcile, "close_orphan_job"],
  ]) {
    assert.ok(
      source.includes(`withOperationConflictRetry("${operation}"`),
      `${operation} must stay wrapped in the bounded database-conflict retry`,
    );
  }
  assert.doesNotMatch(core, /withOperationConflictRetry\("verify_terminal_recovery"/u);
  assert.doesNotMatch(reconcile, /withOperationConflictRetry\("reconcile_close_orphan_job"/u);
  // External IO is still forbidden inside these SQL retry callbacks.
  assert.doesNotMatch(core, /await sql\.begin\(\(tx\) => createJobInTransaction/u);
  assert.doesNotMatch(core, /return sql\.begin\(\(tx\) => ensureCanvasForTaskInTransaction/u);
});
