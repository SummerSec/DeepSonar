import type { ReportInput } from "./report.js";

const STATUS_HEADINGS: Record<string, string> = {
  "confirmed": "confirmed",
  "confirmed findings": "confirmed",
  "confirmed issues": "confirmed",
  "refuted": "refuted",
  "refuted findings": "refuted",
  "inconclusive": "inconclusive",
  "inconclusive findings": "inconclusive",
  "needs human": "needs_human",
  "needs_human": "needs_human",
  "awaiting human confirmation": "needs_human",
  "not automatically verified": "excluded",
  "not automatically verified (severity policy)": "excluded",
  "已确认": "confirmed",
  "已确认问题": "confirmed",
  "已排除": "refuted",
  "未证实": "inconclusive",
  "待人工确认": "needs_human",
  "待人工确认 / 验证限制": "needs_human",
  "未自动验证": "excluded",
  "未自动验证（严重度策略）": "excluded",
};

/** Only an exact ID in its status chapter covers a Finding; titles/status prose do not. */
export function taskReportCoverageOk(input: Pick<ReportInput, "findings">, markdown: string): boolean {
  const findings = new Map(input.findings.map((finding) => [finding.id, finding]));
  if (findings.size !== input.findings.length) return false;
  const counts = new Map<string, number>();
  let section: string | undefined;
  let fence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]!;
      else if (fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^\s{0,3}(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      section = heading[1] === "##" ? STATUS_HEADINGS[heading[2]!.toLowerCase()] : undefined;
      continue;
    }
    // IDs are opaque ASCII tokens. This prevents finding-1 matching finding-10,
    // and a repeated title from standing in for any number of distinct IDs.
    for (const id of line.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
      const finding = findings.get(id);
      if (!finding) continue;
      const expected = finding.verification_policy?.eligibility === "below_min_verify_severity"
        ? "excluded" : finding.verify_status;
      if (section !== expected) return false;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return input.findings.every((finding) => counts.get(finding.id) === 1);
}
