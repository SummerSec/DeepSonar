/**
 * #871 A：可恢复的数据库锁冲突（死锁 / 序列化失败 / 锁超时）在**安全事务边界**
 * 有界重试。
 *
 * 安全边界指的是：被重试的事务若尚未提交，就没有任何外部副作用可被重复执行。
 * 网关的 admission 事务（`sql.begin(admitGatewayRequest)`，内含 `beginEffect`）
 * 正是这样的边界——它在向上游发出请求之前完成，回滚后计数器与 effect 一起消失，
 * 因此重试不会重复计费、不会重复发送模型请求，也不会绕过 unknown effect 的规则。
 * 已经发出外部请求之后的重试不在本模块范围内。
 */
import { inc } from "./metrics.js";

export const DB_CONFLICT_MAX_ATTEMPTS = 3;
/** 冲突退避基数（毫秒）；第 n 次冲突等待 base * 2^(n-1)。 */
export const DB_CONFLICT_BACKOFF_MS = 25;

/** 可恢复的数据库冲突：死锁、序列化失败、锁超时（含 NOWAIT/跳过锁定的等待失败）。 */
export function isRetryableDatabaseConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; cause?: unknown };
  const code = typeof record.code === "string" ? record.code : null;
  if (code === "40P01" || code === "40001" || code === "55P03") return true;
  // postgres.js 有时把驱动错误挂在 cause 上（例如包裹过的连接错误）。
  return record.cause ? isRetryableDatabaseConflict(record.cause) : false;
}

export type DatabaseConflictRetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onConflict?: (error: unknown, attempt: number) => void;
};

export class DatabaseConflictExhaustedError extends Error {
  readonly code = "DATABASE_CONFLICT_EXHAUSTED" as const;
  readonly attempts: number;
  readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(`数据库锁冲突在 ${attempts} 次尝试后仍未恢复`);
    this.name = "DatabaseConflictExhaustedError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 执行一个事务并在可恢复冲突上有界重试。
 *
 * - 只有 `isRetryableDatabaseConflict` 认定的错误才重试，其余立即抛出；
 * - 重试次数用尽时抛出 `DatabaseConflictExhaustedError`，调用方据此返回稳定错误码，
 *   而不是把它当作模型/Agent 语义失败；
 * - 每次冲突都通过 `onConflict` 汇报，供指标与日志关联 attempt/canvas。
 */
export async function withDatabaseConflictRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: DatabaseConflictRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? DB_CONFLICT_MAX_ATTEMPTS));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DB_CONFLICT_BACKOFF_MS);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!isRetryableDatabaseConflict(error)) throw error;
      lastError = error;
      options.onConflict?.(error, attempt);
      if (attempt === attempts) break;
      if (baseDelayMs > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new DatabaseConflictExhaustedError(attempts, lastError);
}

const SQLSTATE_LABEL_CODES = new Set(["40P01", "40001", "55P03"]);

function sqlstateLabel(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SQLSTATE_LABEL_CODES.has(code) ? code : "unknown";
}

/**
 * #945：给具体事务入口用的一层包装。
 *
 * 行为与 `withDatabaseConflictRetry` 完全一致（同一个重试器、同一套退避），
 * 额外做两件事：把 `{operation, code}` 写进现有指标，并保证耗尽时抛出的是
 * `DatabaseConflictExhaustedError`（可诊断、不污染成 PostgresError 原文）。
 *
 * 新增模块而不是另建重试器：仓库已经有一套有界重试（#871），一个系统只应该有
 * 一个重试语义；此处只是把它接到此前漏接的事务入口上。
 */
export async function withOperationConflictRetry<T>(
  operation: string,
  run: (attempt: number) => Promise<T>,
  options: DatabaseConflictRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? DB_CONFLICT_MAX_ATTEMPTS));
  return withDatabaseConflictRetry(run, {
    ...options,
    onConflict(error, attempt) {
      const labels = { operation, code: sqlstateLabel(error) };
      inc("deepsonar_database_conflict_retries_total", labels);
      const exhausted = attempt === attempts;
      if (exhausted) inc("deepsonar_database_conflict_exhausted_total", labels);
      console.warn("[db-conflict] recoverable conflict", { ...labels, attempt, exhausted });
      options.onConflict?.(error, attempt);
    },
  });
}
