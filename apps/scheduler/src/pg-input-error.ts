/**
 * PostgreSQL JSONB 输入拒绝（#1066）。
 *
 * `\u0000` 进入 JSONB 文本转换时 PG 返回 22P05
 * ("unsupported Unicode escape sequence ... cannot be converted to text.")，
 * dispatcher 过去把它当未分类异常，attempt 失败文本直接是 DB 原文（无稳定码、
 * 无 RepairFeedback 语义）。事件写入面已由
 * `domains/event-ingestion/pg-text-safety.ts` 清洗，这里兜住其余 22P05 来源，
 * 给出稳定 reason 与平台文案，绝不回显数据库原文。
 */
export const EVENT_PAYLOAD_CONTROL_CHARACTERS_REASON = "event_payload_control_characters";

const PG_JSONB_INPUT_RE = /(?:unsupported Unicode escape sequence|\b22P05\b)/iu;

export function isPgInputErrorMessage(text: string): boolean {
  return PG_JSONB_INPUT_RE.test(text);
}

export const EVENT_PAYLOAD_CONTROL_CHARACTERS_MESSAGE =
  `${EVENT_PAYLOAD_CONTROL_CHARACTERS_REASON}: 事件载荷含 PostgreSQL 拒绝的 U+0000 控制字符；请改用可打印文本重新提交，数据库原文不进入 attempt 终态。`;