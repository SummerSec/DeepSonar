/**
 * PostgreSQL 拒绝 U+0000 进入 JSONB 文本转换（22P05:
 * "unsupported Unicode escape sequence ... cannot be converted to text."）。
 * CLI/proxy 帧可能带入真实 NUL；#548 只清洗了 canvas_nodes 写入面，
 * events 主插入与 control_receipt 事件仍会被击穿并回滚已受理的完成回执
 * （#1066，2026-11-10 现场：Job 21:39:50 受理 mark_job_done → 21:40:11 failed）。
 *
 * 其余 C0 控制字符是合法 JSONB 转义，且 \n、\t 在事件正文里承载格式，
 * 因此这里只替换 U+0000，不用 #548 的全区间清洗覆盖事件载荷。
 */
export const NUL_REPLACEMENT = "\\0";

/** 深拷贝式清洗：只改字符串叶子，不改变对象身份语义之外的字段集合。 */
export function scrubPostgresJson<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\u0000/gu, NUL_REPLACEMENT) as T;
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
