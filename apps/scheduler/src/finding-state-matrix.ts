/**
 * Finding / human / verify / disposition semantic matrix (#400).
 *
 * These four dimensions are independent. UI and reports must not infer one
 * from another. Scheduler is the only writer of illegal-combination checks.
 */

import type { FindingDisposition } from "./finding-disposition.js";

export const VERIFY_STATUSES = [
  "pending",
  "verifying",
  "confirmed",
  "false_positive",
  "needs_human",
] as const;
export type VerifyStatusValue = (typeof VERIFY_STATUSES)[number];

export const VERIFY_VERDICTS = ["confirmed", "rework", "needs_human"] as const;

export const HUMAN_JOB_STATUS = "waiting_human" as const;

export const CLOSED_DISPOSITIONS = ["rejected_fp", "resolved", "archived"] as const;
export const OPEN_DISPOSITIONS = ["open", "accepted", "human_reproducing"] as const;
export const HIGH_RISK_SEVERITIES = ["critical", "high"] as const;

export type FindingStateDimension =
  | "verify_status"
  | "disposition"
  | "job_waiting_human"
  | "fact_verification_status";

export interface FindingStateRow {
  dimension: FindingStateDimension;
  value: string;
  owner: string;
  writer: string;
  meaning: string;
  report: string;
  terminal: boolean;
}

export const FINDING_STATE_MATRIX: readonly FindingStateRow[] = [
  {
    dimension: "verify_status",
    value: "pending",
    owner: "Scheduler",
    writer: "emit_finding / Verify lifecycle",
    meaning: "技术验证尚未开始或未达 minVerifySeverity",
    report: "未自动验证或仍待 Verify",
    terminal: false,
  },
  {
    dimension: "verify_status",
    value: "verifying",
    owner: "Scheduler",
    writer: "派生 Verify Job",
    meaning: "系统 Verify 轮次进行中",
    report: "不计入 confirmed；不阻塞 Task Report 的待验证章节",
    terminal: false,
  },
  {
    dimension: "verify_status",
    value: "confirmed",
    owner: "Scheduler",
    writer: "verify_finding 硬门（唯一）",
    meaning: "技术验证通过；不是人工处置，也不能旁路 confirmed_vuln",
    report: "可派 Finding Report；进入 Task Report 已确认章节与 SARIF",
    terminal: true,
  },
  {
    dimension: "verify_status",
    value: "needs_human",
    owner: "Scheduler",
    writer: "Verify verdict 或 PATCH /findings/:id/verify-status",
    meaning: "技术验证无法收口，等待人；不是 disposition=human_reproducing",
    report: "待人工章节；不进 SARIF",
    terminal: true,
  },
  {
    dimension: "verify_status",
    value: "false_positive",
    owner: "Scheduler (legacy read)",
    writer: "无（新流程不可写）",
    meaning: "历史 leftover；导入/旧行可读，不能再作为 verdict 或新写入",
    report: "按历史行展示，不映射为 rework",
    terminal: true,
  },
  {
    dimension: "disposition",
    value: "open",
    owner: "Human",
    writer: "PATCH /findings/:id/disposition",
    meaning: "业务未接手",
    report: "未闭环",
    terminal: false,
  },
  {
    dimension: "disposition",
    value: "accepted",
    owner: "Human",
    writer: "PATCH /findings/:id/disposition",
    meaning: "业务已接手跟进",
    report: "未闭环",
    terminal: false,
  },
  {
    dimension: "disposition",
    value: "human_reproducing",
    owner: "Human",
    writer: "PATCH /findings/:id/disposition",
    meaning: "人在手工复现；不是 verify_status=needs_human，也不能旁路 confirmed",
    report: "未闭环；可作 compose 种子",
    terminal: false,
  },
  {
    dimension: "disposition",
    value: "confirmed_vuln",
    owner: "Human",
    writer: "PATCH /findings/:id/disposition（仅当 verify_status=confirmed）",
    meaning: "人工确认漏洞存在；必须以系统 Verify confirmed 为前提",
    report: "业务已确认风险；仍不是 Verify 本身",
    terminal: true,
  },
  {
    dimension: "disposition",
    value: "rejected_fp",
    owner: "Human",
    writer: "PATCH /findings/:id/disposition",
    meaning: "业务否定为误报；不改写 verify_status",
    report: "已闭环否定",
    terminal: true,
  },
  {
    dimension: "disposition",
    value: "resolved",
    owner: "Human",
    writer: "PATCH /findings/:id/disposition",
    meaning: "业务已修复/关闭",
    report: "已闭环",
    terminal: true,
  },
  {
    dimension: "disposition",
    value: "archived",
    owner: "Human",
    writer: "PATCH /findings/:id/disposition",
    meaning: "不再跟进",
    report: "已闭环归档",
    terminal: true,
  },
  {
    dimension: "job_waiting_human",
    value: HUMAN_JOB_STATUS,
    owner: "Scheduler",
    writer: "request_human",
    meaning: "当前 Job Attempt 暂停等人；不是 Finding 技术验证或处置",
    report: "任务阻塞，不改变 Finding 状态",
    terminal: false,
  },
] as const;

export const CONFIRMED_VULN_REQUIRES_VERIFY = "confirmed_vuln_requires_verify" as const;

export function isClosedDisposition(disposition: string): boolean {
  return (CLOSED_DISPOSITIONS as readonly string[]).includes(disposition);
}

export function isOpenDisposition(disposition: string): boolean {
  return (OPEN_DISPOSITIONS as readonly string[]).includes(disposition);
}

export function isHighRiskSeverity(severity: string | null | undefined): boolean {
  return (HIGH_RISK_SEVERITIES as readonly string[]).includes(String(severity ?? "").toLowerCase());
}

/** 高风险未闭环：明确 critical/high，且处置仍需跟进（不含 confirmed_vuln）。 */
export function isOpenHighRiskFinding(input: {
  severity?: string | null;
  disposition?: string | null;
}): boolean {
  const disposition = String(input.disposition ?? "open");
  return isHighRiskSeverity(input.severity) && isOpenDisposition(disposition);
}

export function dispositionAllowed(
  verifyStatus: string,
  disposition: string,
): { ok: true } | { ok: false; error_code: typeof CONFIRMED_VULN_REQUIRES_VERIFY } {
  if (disposition === "confirmed_vuln" && verifyStatus !== "confirmed") {
    return { ok: false, error_code: CONFIRMED_VULN_REQUIRES_VERIFY };
  }
  return { ok: true };
}

export function assertDispositionAllowed(verifyStatus: string, disposition: FindingDisposition): void {
  const result = dispositionAllowed(verifyStatus, disposition);
  if (!result.ok) {
    throw Object.assign(new Error(result.error_code), { code: result.error_code });
  }
}
