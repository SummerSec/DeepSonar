/**
 * PostgreSQL 拒绝 U+0000 进入 JSONB 文本转换（22P05:
 * "unsupported Unicode escape sequence ... cannot be converted to text."）。
 * CLI/proxy 帧可能带入真实 NUL；#548 只清洗了 canvas_nodes 写入面，
 * events 主插入仍会被击穿（#1066，2026-11-10 现场：Job 21:39:50 受理 mark_job_done
 * → 21:40:11 attempt 失败，失败文本是数据库原文）。
 *
 * 策略是「值清洗 + 身份敏感面拒绝」：
 * - 字符串值把 U+0000 换成字面 `\0`（其余 C0 是合法 JSONB 转义，且 \n、\t 承载事件
 *   正文格式，所以不用 #548 的全区间清洗）；
 * - 对象键不接受替换：重命名会与既有键（如字面 `a\0b`）碰撞并静默丢字段，因此由
 *   `findPayloadNul` 检出后按结构化输入错误拒绝；
 * - `plan` 这类承载提案身份的语义载荷同样拒绝：存储端清洗会让「原样重放」的
 *   digest 与清洗后的存储值不一致，破坏已接受提案的幂等身份。
 */
export const NUL_REPLACEMENT = "\\0";

/** 值清洗：只替换 U+0000，保留换行/制表符等有格式含义的控制字符。 */
export function scrubPostgresText(value: string): string {
  return value.replace(/\u0000/gu, NUL_REPLACEMENT);
}

/** 深拷贝式清洗：只改字符串叶子，不改动对象键，不改变入参。 */
export function scrubPostgresJson<T>(value: T): T {
  if (typeof value === "string") return scrubPostgresText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => scrubPostgresJson(entry)) as T;
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, scrubPostgresJson(entry)]),
      ) as T;
    }
  }
  return value;
}

export interface PayloadNulFinding {
  kind: "key" | "value";
  path: string;
}

/** 先看键（任意类型都必须拒绝），再看值（仅身份敏感载荷拒绝）。 */
export function payloadNulPolicy(type: string, payload: unknown): PayloadNulFinding | null {
  const key = findPayloadNul(payload, false);
  if (key) return key;
  return type === "plan" ? findPayloadNul(payload, true) : null;
}

/** 检出第一处 U+0000：对象键（任意类型）或字符串值（仅用于身份敏感载荷）。 */
export function findPayloadNul(value: unknown, wantValues = false, path = "payload"): PayloadNulFinding | null {
  if (typeof value === "string") return wantValues && value.includes("\u0000") ? { kind: "value", path } : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPayloadNul(value[index], wantValues, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key.includes("\u0000")) return { kind: "key", path: `${path}.<nul-key>` };
      const found = findPayloadNul(entry, wantValues, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}
