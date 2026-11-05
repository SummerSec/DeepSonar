import postgres from "postgres";
import type { MigrationConnection } from "./migration-runner.js";
import { RECONCILE_INPUT_SCHEMA, RECONCILE_RESULT_SCHEMA } from "./domains/job-attempt/reconcile-effects.js";
import {
  OPERATOR_SETTLE_OUTCOMES,
  countUnsettledEffects,
  runEffectReconcile,
  settleEffectByOperator,
  type OperatorSettleOutcome,
  type ReconcileAction,
} from "./domains/job-attempt/reconcile-effects-runner.js";

// Host-invoked effect reconciliation (#845 defect 3): credentials and SQL never appear
// in argv, only on stdin, and no driver message is ever printed.
const SAFE_ERROR_CODES = new Set([
  "INVALID_INPUT",
  "INPUT_LIMIT",
  "INVALID_CONNECTION",
  "INVALID_RECONCILE_ACTION",
  "INVALID_RECONCILE_OPERATION_ID",
  "INVALID_RECONCILE_LIMIT",
  "INVALID_EFFECT_ID",
  "INVALID_SETTLE_OUTCOME",
  "INVALID_SETTLE_EVIDENCE",
]);

let connection: ReturnType<typeof postgres> | undefined;
try {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("INPUT_LIMIT");
  }
  const input = JSON.parse(raw) as {
    schema?: string;
    action?: ReconcileAction | "settle";
    operation_id?: string;
    limit?: number;
    effect_id?: string;
    outcome?: OperatorSettleOutcome;
    evidence?: string;
    connection?: { host?: string; port?: number; username?: string; password?: string; database?: string };
  };
  if (input.schema !== RECONCILE_INPUT_SCHEMA) throw new Error("INVALID_INPUT");
  const { host, port, username, password, database } = input.connection ?? {};
  if (typeof host !== "string" || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535
    || typeof username !== "string" || typeof password !== "string" || typeof database !== "string" || !database) {
    throw new Error("INVALID_CONNECTION");
  }
  if (input.action !== "scan" && input.action !== "apply" && input.action !== "settle") {
    throw new Error("INVALID_RECONCILE_ACTION");
  }
  // #899: an effect that platform evidence cannot decide is settled once by an operator,
  // with a written reason, instead of being hand-edited in the database or replayed.
  if (input.action === "settle") {
    if (typeof input.effect_id !== "string") throw new Error("INVALID_EFFECT_ID");
    if (typeof input.outcome !== "string" || !OPERATOR_SETTLE_OUTCOMES.includes(input.outcome as OperatorSettleOutcome)) {
      throw new Error("INVALID_SETTLE_OUTCOME");
    }
    if (typeof input.evidence !== "string") throw new Error("INVALID_SETTLE_EVIDENCE");
  }
  connection = postgres({
    host, port: port as number, username, password, database, max: 1, connect_timeout: 10, onnotice: () => {},
    connection: { application_name: "deepsonar-effect-reconcile" },
  });
  const reserved = await connection.reserve();
  try {
    if (input.action === "settle") {
      const settled = await settleEffectByOperator(reserved as unknown as MigrationConnection, {
        effect_id: input.effect_id as string,
        outcome: input.outcome as OperatorSettleOutcome,
        evidence: input.evidence as string,
        operation_id: input.operation_id ?? "",
      });
      // #908 review P2: report the effects that are actually still unsettled; a single
      // operator settlement cannot claim the backlog is empty.
      const remaining = await countUnsettledEffects(reserved as unknown as MigrationConnection);
      process.stdout.write(`${JSON.stringify({ schema: RECONCILE_RESULT_SCHEMA, ok: remaining === 0, action: "settle", applied: settled.settled ? 1 : 0, remaining_unknown: remaining, ...settled })}\n`);
      if (!settled.settled) process.exitCode = 1;
    } else {
    // SAFETY: a reserved postgres connection exposes the same tagged-template and
    // unsafe() surface MigrationConnection declares; the narrow type only hides the
    // pool-specific methods this runner never calls.
      const result = await runEffectReconcile(reserved as unknown as MigrationConnection, {
        action: input.action as ReconcileAction,
        operation_id: input.operation_id ?? "",
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      process.stdout.write(`${JSON.stringify({ schema: RECONCILE_RESULT_SCHEMA, ...result })}\n`);
      process.exitCode = result.ok ? 0 : 1;
    }
  } finally {
    reserved.release();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const code = SAFE_ERROR_CODES.has(message) ? message : "EFFECT_RECONCILE_FAILED";
  process.stdout.write(`${JSON.stringify({ schema: RECONCILE_RESULT_SCHEMA, ok: false, action: "scan", applied: 0, remaining_unknown: 0, blocking_errors: [{ code }] })}\n`);
  process.exitCode = 1;
} finally {
  await connection?.end({ timeout: 5 });
}