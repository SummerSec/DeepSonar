/**
 * Security vulnerability proof contract (#578).
 *
 * Governed for profile `security.vulnerability` — not a universal dynamic PoC
 * gate. Verify only consumes Facts; it does not re-review source. Weak signals
 * alone (TODO/FIXME, dangerous-function presence, mere line hits) cannot
 * satisfy the strategy. Tool / target / device gaps → inconclusive.
 */
import { isRuntimeProof, type RuntimeProofView } from "./verify-evidence-chain.js";

export const VULN_PROOF_STRATEGY_ID = "security.vulnerability.proof" as const;
export const VULN_PROOF_STRATEGY_VERSION = 1 as const;
export const VULN_PROOF_PROFILE = "security.vulnerability" as const;

export type VulnProofPath = "static" | "dynamic";

export type VulnWeakSignal =
  | "todo_or_fixme_comment"
  | "dangerous_function_presence"
  | "line_hit_only"
  | "comment_only";

export type VulnImpactStatus = "demonstrated" | "assumed" | "unproven";
export type VulnProtectionStatus = "none" | "present" | "bypassable" | "unknown";
export type VulnToolStatus = "available" | "missing" | "unknown";
export type VulnProofResult = "passed" | "insufficient" | "inconclusive" | "rejected";

export type VulnStaticLocation = {
  path: string;
  start_line?: number | null;
  end_line?: number | null;
  snippet_digest?: string | null;
};

export type VulnProofClaim = {
  profile: string;
  proof_path: VulnProofPath;
  /** When true, static narrative alone cannot pass. */
  dynamic_required?: boolean;
  subject_revision: string;
  affected_component: string;
  attacker_control_points: readonly string[];
  preconditions: readonly string[];
  reachability_path: string;
  reachability?: "reachable" | "unreachable" | "unknown";
  protections?: readonly string[];
  protection_status?: VulnProtectionStatus;
  protection_bypass?: string | null;
  impact: {
    status: VulnImpactStatus;
    description: string;
    privilege_boundary?: string | null;
  };
  weak_signals?: readonly VulnWeakSignal[];
  static_locations?: readonly VulnStaticLocation[];
  path_rationale?: string | null;
  runtime?: RuntimeProofView | null;
  tool_status?: VulnToolStatus;
  missing_tools?: readonly string[];
  missing_target?: boolean;
  missing_device?: boolean;
  unproven_assumptions?: readonly string[];
  next_evidence_needs?: readonly string[];
};

export type VulnProofDecision = {
  strategy_id: typeof VULN_PROOF_STRATEGY_ID;
  strategy_version: typeof VULN_PROOF_STRATEGY_VERSION;
  profile: typeof VULN_PROOF_PROFILE;
  ok: boolean;
  result: VulnProofResult;
  required_missing: string[];
  reasons: string[];
  proof_path: VulnProofPath | null;
  weak_signal_only: boolean;
  confirm_reason: string | null;
};

const WEAK_SIGNALS = new Set<string>([
  "todo_or_fixme_comment",
  "dangerous_function_presence",
  "line_hit_only",
  "comment_only",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function substantive(value: unknown, min = 12): boolean {
  return text(value).length >= min;
}

function hasStaticLocations(claim: VulnProofClaim): boolean {
  return (claim.static_locations ?? []).some((loc) => text(loc.path).length > 0);
}

function hasSnippetDigest(claim: VulnProofClaim): boolean {
  return (claim.static_locations ?? []).some((loc) => substantive(loc.snippet_digest, 8));
}

function runtimeForClaim(claim: VulnProofClaim): RuntimeProofView {
  const runtime = claim.runtime ?? {};
  return {
    subject_revision: text(runtime.subject_revision) || claim.subject_revision,
    steps: runtime.steps,
    environment: runtime.environment,
    runtime_digest: runtime.runtime_digest,
    exit_code: runtime.exit_code,
    artifact_refs: runtime.artifact_refs,
    expected: runtime.expected,
    actual: runtime.actual,
  };
}

/** True when claim offers only weak signals without reachability / impact proof. */
export function isWeakSignalOnly(claim: VulnProofClaim): boolean {
  const signals = claim.weak_signals ?? [];
  if (signals.length === 0) return false;
  const reach = substantive(claim.reachability_path) || substantive(claim.path_rationale);
  const staticOk = hasStaticLocations(claim) && hasSnippetDigest(claim) && reach;
  const dynamicOk = claim.proof_path === "dynamic" && isRuntimeProof(runtimeForClaim(claim));
  const impactOk =
    claim.impact.status === "demonstrated" && substantive(claim.impact.description, 10);
  if (staticOk && impactOk) return false;
  if (dynamicOk && impactOk) return false;
  return true;
}

export function parseVulnProofClaim(raw: unknown): VulnProofClaim | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const proof_path = o.proof_path === "static" || o.proof_path === "dynamic" ? o.proof_path : null;
  if (!proof_path) return null;
  const impactRaw = o.impact;
  if (!impactRaw || typeof impactRaw !== "object" || Array.isArray(impactRaw)) return null;
  const impactObj = impactRaw as Record<string, unknown>;
  const impactStatus =
    impactObj.status === "demonstrated" ||
    impactObj.status === "assumed" ||
    impactObj.status === "unproven"
      ? impactObj.status
      : null;
  if (!impactStatus) return null;

  const weak = Array.isArray(o.weak_signals)
    ? o.weak_signals.filter((x): x is VulnWeakSignal => typeof x === "string" && WEAK_SIGNALS.has(x))
    : [];

  const static_locations = Array.isArray(o.static_locations)
    ? o.static_locations
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
        .map((loc) => ({
          path: text(loc.path),
          start_line: typeof loc.start_line === "number" ? loc.start_line : null,
          end_line: typeof loc.end_line === "number" ? loc.end_line : null,
          snippet_digest: text(loc.snippet_digest) || null,
        }))
        .filter((loc) => loc.path.length > 0)
    : [];

  return {
    profile: text(o.profile) || VULN_PROOF_PROFILE,
    proof_path,
    dynamic_required: o.dynamic_required === true,
    subject_revision: text(o.subject_revision),
    affected_component: text(o.affected_component),
    attacker_control_points: Array.isArray(o.attacker_control_points)
      ? o.attacker_control_points.map((x) => text(x)).filter(Boolean)
      : [],
    preconditions: Array.isArray(o.preconditions)
      ? o.preconditions.map((x) => text(x)).filter(Boolean)
      : [],
    reachability_path: text(o.reachability_path),
    reachability:
      o.reachability === "reachable" ||
      o.reachability === "unreachable" ||
      o.reachability === "unknown"
        ? o.reachability
        : undefined,
    protections: Array.isArray(o.protections)
      ? o.protections.map((x) => text(x)).filter(Boolean)
      : undefined,
    protection_status:
      o.protection_status === "none" ||
      o.protection_status === "present" ||
      o.protection_status === "bypassable" ||
      o.protection_status === "unknown"
        ? o.protection_status
        : undefined,
    protection_bypass: text(o.protection_bypass) || null,
    impact: {
      status: impactStatus,
      description: text(impactObj.description),
      privilege_boundary: text(impactObj.privilege_boundary) || null,
    },
    weak_signals: weak,
    static_locations,
    path_rationale: text(o.path_rationale) || null,
    runtime: (o.runtime as RuntimeProofView | null | undefined) ?? null,
    tool_status:
      o.tool_status === "available" || o.tool_status === "missing" || o.tool_status === "unknown"
        ? o.tool_status
        : undefined,
    missing_tools: Array.isArray(o.missing_tools)
      ? o.missing_tools.map((x) => text(x)).filter(Boolean)
      : undefined,
    missing_target: o.missing_target === true,
    missing_device: o.missing_device === true,
    unproven_assumptions: Array.isArray(o.unproven_assumptions)
      ? o.unproven_assumptions.map((x) => text(x)).filter(Boolean)
      : undefined,
    next_evidence_needs: Array.isArray(o.next_evidence_needs)
      ? o.next_evidence_needs.map((x) => text(x)).filter(Boolean)
      : undefined,
  };
}

export function extractVulnProofClaimFromRows(
  rows: readonly Record<string, unknown>[],
): VulnProofClaim | null {
  for (const row of rows) {
    const direct = parseVulnProofClaim(row.vuln_proof);
    if (direct) return direct;
    const verification = row.verification;
    if (verification && typeof verification === "object" && !Array.isArray(verification)) {
      const nested = parseVulnProofClaim((verification as Record<string, unknown>).vuln_proof);
      if (nested) return nested;
    }
    const body = row.body_json ?? row.body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      const fromBody = parseVulnProofClaim(b.vuln_proof);
      if (fromBody) return fromBody;
      const v = b.verification;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const fromV = parseVulnProofClaim((v as Record<string, unknown>).vuln_proof);
        if (fromV) return fromV;
      }
    }
  }
  return null;
}

function environmentGaps(claim: VulnProofClaim): string[] {
  const missing: string[] = [];
  if (claim.tool_status === "missing" || (claim.missing_tools?.length ?? 0) > 0) {
    missing.push("tool_missing");
  }
  if (claim.missing_target === true) missing.push("target_missing");
  if (claim.missing_device === true) missing.push("device_missing");
  return missing;
}

function decisionBase(
  proof_path: VulnProofPath | null = null,
): Pick<VulnProofDecision, "strategy_id" | "strategy_version" | "profile" | "proof_path"> {
  return {
    strategy_id: VULN_PROOF_STRATEGY_ID,
    strategy_version: VULN_PROOF_STRATEGY_VERSION,
    profile: VULN_PROOF_PROFILE,
    proof_path,
  };
}

/**
 * Evaluate a security.vulnerability proof claim.
 * When claim is null and requireClaim is false, returns ok (opt-in gate).
 */
export function evaluateVulnProofContract(
  claim: VulnProofClaim | null | undefined,
  opts?: { requireClaim?: boolean },
): VulnProofDecision {
  if (!claim) {
    if (opts?.requireClaim === false) {
      return {
        ...decisionBase(null),
        ok: true,
        result: "passed",
        required_missing: [],
        reasons: [],
        weak_signal_only: false,
        confirm_reason: null,
      };
    }
    return {
      ...decisionBase(null),
      ok: false,
      result: "insufficient",
      required_missing: ["vuln_proof_claim"],
      reasons: ["安全漏洞证明策略要求可冻结的 vuln_proof 声明，但参与 Fact 未提供"],
      weak_signal_only: false,
      confirm_reason: null,
    };
  }

  const required_missing: string[] = [];
  const reasons: string[] = [];
  const proof_path = claim.proof_path;

  if (text(claim.profile) && text(claim.profile) !== VULN_PROOF_PROFILE) {
    return {
      ...decisionBase(proof_path),
      ok: false,
      result: "rejected",
      required_missing: ["profile_mismatch"],
      reasons: [`证明契约仅适用于 ${VULN_PROOF_PROFILE}，收到 profile=${claim.profile}`],
      weak_signal_only: false,
      confirm_reason: null,
    };
  }

  if (!substantive(claim.subject_revision, 1)) {
    required_missing.push("subject_revision");
    reasons.push("缺少固定目标 revision");
  }
  if (!substantive(claim.affected_component, 1)) {
    required_missing.push("affected_component");
    reasons.push("缺少受影响组件");
  }
  if (claim.attacker_control_points.length === 0) {
    required_missing.push("attacker_control_points");
    reasons.push("缺少攻击者控制点");
  }
  if (claim.preconditions.length === 0) {
    required_missing.push("preconditions");
    reasons.push("缺少前置条件");
  }

  const gaps = environmentGaps(claim);
  if (gaps.length > 0) {
    return {
      ...decisionBase(proof_path),
      ok: false,
      result: "inconclusive",
      required_missing: [...new Set([...required_missing, ...gaps])],
      reasons: [
        ...reasons,
        "工具/目标/设备缺失：按协议降为证据不足（inconclusive），不得用源码叙述替代执行观察",
      ],
      weak_signal_only: false,
      confirm_reason: null,
    };
  }

  if (isWeakSignalOnly(claim)) {
    return {
      ...decisionBase(proof_path),
      ok: false,
      result: "rejected",
      required_missing: [...new Set([...required_missing, "weak_signal_only"])],
      reasons: [
        ...reasons,
        "TODO/注释/危险函数存在/单纯行号命中不能单独满足漏洞证明策略",
      ],
      weak_signal_only: true,
      confirm_reason: null,
    };
  }

  if (claim.reachability === "unreachable") {
    return {
      ...decisionBase(proof_path),
      ok: false,
      result: "rejected",
      required_missing: [...new Set([...required_missing, "unreachable"])],
      reasons: [...reasons, "可达性判定为 unreachable：不可作为 supports 确认依据"],
      weak_signal_only: false,
      confirm_reason: null,
    };
  }

  if (claim.protection_status === "present" && !substantive(claim.protection_bypass, 8)) {
    required_missing.push("protection_bypass");
    reasons.push("存在保护机制但未说明可绕过依据");
  }

  if (claim.impact.status === "assumed" || claim.impact.status === "unproven") {
    required_missing.push("impact_not_demonstrated");
    reasons.push("影响仅为假设/未证实，不能当作已证实安全影响");
  } else if (!substantive(claim.impact.description, 10)) {
    required_missing.push("impact_description");
    reasons.push("缺少已证实影响描述");
  }

  if (!substantive(claim.reachability_path) && !substantive(claim.path_rationale)) {
    required_missing.push("reachability_path");
    reasons.push("缺少入口到危险操作/安全检查的可达路径依据");
  }

  if (proof_path === "static") {
    if (claim.dynamic_required === true) {
      required_missing.push("dynamic_proof_required");
      reasons.push("该类型要求动态复现，不能只用静态叙述过门");
    } else {
      if (!hasStaticLocations(claim)) {
        required_missing.push("static_locations");
        reasons.push("静态证明须保留文件位置");
      }
      if (!hasSnippetDigest(claim)) {
        required_missing.push("snippet_digest");
        reasons.push("静态证明须保留片段摘要（snippet_digest）");
      }
    }
  } else if (!isRuntimeProof(runtimeForClaim(claim))) {
    required_missing.push("runtime_proof");
    reasons.push(
      "动态证明须保存步骤、环境或 runtime_digest、exit_code/产物摘要；文本 expected/actual 不足",
    );
  }

  const unique = [...new Set(required_missing)];
  if (unique.length > 0) {
    return {
      ...decisionBase(proof_path),
      ok: false,
      result: "insufficient",
      required_missing: unique,
      reasons,
      weak_signal_only: false,
      confirm_reason: null,
    };
  }

  return {
    ...decisionBase(proof_path),
    ok: true,
    result: "passed",
    required_missing: [],
    reasons: [],
    weak_signal_only: false,
    confirm_reason: `${VULN_PROOF_STRATEGY_ID}_v${VULN_PROOF_STRATEGY_VERSION}_${proof_path}_passed`,
  };
}

export function vulnProofAuditFields(decision: VulnProofDecision): Record<string, unknown> {
  return {
    strategy_id: decision.strategy_id,
    strategy_version: decision.strategy_version,
    profile: decision.profile,
    ok: decision.ok,
    result: decision.result,
    required_missing: decision.required_missing,
    reasons: decision.reasons,
    proof_path: decision.proof_path,
    weak_signal_only: decision.weak_signal_only,
    confirm_reason: decision.confirm_reason,
  };
}

/** Merge Fact-first (+ integrity) with vuln proof. Does not rewrite Hub wake fingerprints. */
export function mergeStrategyWithVulnProof<
  T extends {
    ok: boolean;
    required_missing: string[];
    reasons: string[];
    confirm_reason: string | null;
  },
>(strategy: T, vuln: VulnProofDecision): T {
  if (vuln.ok) return strategy;
  return {
    ...strategy,
    ok: false,
    required_missing: [...new Set([...strategy.required_missing, ...vuln.required_missing])],
    reasons: [...strategy.reasons, ...vuln.reasons],
    confirm_reason: null,
  };
}

/** Frozen strategy metadata for capability-pack / project policy audit. */
export function frozenVulnProofStrategyMeta(): Record<string, unknown> {
  return {
    strategy_id: VULN_PROOF_STRATEGY_ID,
    strategy_version: VULN_PROOF_STRATEGY_VERSION,
    profile: VULN_PROOF_PROFILE,
    allowed_proof_paths: ["static", "dynamic"],
    weak_signals_rejected_alone: [...WEAK_SIGNALS],
    environment_gaps: ["tool_missing", "target_missing", "device_missing"],
    note: "非通用 PoC 门禁；仅 security.vulnerability 受治理启用时生效；Verify 只消费 Fact",
  };
}
