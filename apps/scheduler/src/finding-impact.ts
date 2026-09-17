/**
 * Finding impact schema + confirm gate hook (#590).
 * security.vulnerability confirmed requires impact_flow or explicit waiver.
 */
import { textField, profileRequiresEvidencePair } from "./verify-fact-gate.js";
import type { FindingImpact as SharedFindingImpact } from "@deepsonar/shared-types";

export type FindingImpact = SharedFindingImpact;

export type ImpactConfirmDecision = {
  ok: boolean;
  required_missing: string[];
  reasons: string[];
};

const KNOWN_ISSUE_PATTERNS: RegExp[] = [
  /\bTODO\s*\(\s*([^)]+)\)/gi,
  /\bFIXME\s*\(\s*([^)]+)\)/gi,
  /\bcrbug\.com\/(\d+)\b/gi,
  /\bbugs\.chromium\.org\/p\/chromium\/issues\/detail\?id=(\d+)\b/gi,
  /\bCVE-\d{4}-\d{4,7}\b/gi,
];

function optionalText(value: unknown): string | undefined {
  const text = textField(value);
  return text.length > 0 ? text : undefined;
}

export function normalizeFindingImpact(raw: unknown): FindingImpact | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const preconditions = Array.isArray(o.preconditions)
    ? o.preconditions.map((v) => String(v).trim()).filter(Boolean).slice(0, 32)
    : [];
  const known = Array.isArray(o.known_issue_refs)
    ? o.known_issue_refs.map((v) => String(v).trim()).filter(Boolean).slice(0, 32)
    : [];
  const impact: FindingImpact = {
    ...(optionalText(o.attacker_entry) ? { attacker_entry: optionalText(o.attacker_entry) } : {}),
    ...(optionalText(o.victim_resource) ? { victim_resource: optionalText(o.victim_resource) } : {}),
    ...(optionalText(o.impact_flow) ? { impact_flow: optionalText(o.impact_flow) } : {}),
    ...(preconditions.length > 0 ? { preconditions } : {}),
    ...(known.length > 0 ? { known_issue_refs: known } : {}),
    ...(optionalText(o.impact_waiver) ? { impact_waiver: optionalText(o.impact_waiver) } : {}),
  };
  return Object.keys(impact).length > 0 ? impact : undefined;
}

export function extractKnownIssueRefs(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const pattern of KNOWN_ISSUE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) != null) {
        const token = match[0].trim();
        if (token) found.add(token);
        if (found.size >= 32) return [...found];
      }
    }
  }
  return [...found];
}

export function evaluateImpactForConfirm(
  findingProfile: string | null | undefined,
  impact: FindingImpact | null | undefined,
): ImpactConfirmDecision {
  if (!profileRequiresEvidencePair(findingProfile)) {
    return { ok: true, required_missing: [], reasons: [] };
  }
  const flow = textField(impact?.impact_flow);
  const waiver = textField(impact?.impact_waiver);
  if (flow.length > 0 || waiver.length > 0) {
    return { ok: true, required_missing: [], reasons: [] };
  }
  return {
    ok: false,
    required_missing: ["impact_flow"],
    reasons: ["security.vulnerability confirmed 需要非空 impact.impact_flow，或显式 impact_waiver"],
  };
}
