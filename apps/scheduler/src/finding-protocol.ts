import type {
  EffectiveFindingProtocol,
  EmitFindingPayload,
  FindingPayload,
  FindingProtocolConfig,
  FindingScoringProposal,
  Severity,
} from "@deepsonar/shared-types";
import type { Cvss3P1, Cvss4P0 } from "ae-cvss-calculator";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cvss = require("ae-cvss-calculator") as {
  Cvss3P1: new (vector: string) => Cvss3P1;
  Cvss4P0: new (vector: string) => Cvss4P0;
};

export const CVSS_CALCULATOR = "ae-cvss-calculator@1.0.13";

export const DEFAULT_FINDING_PROTOCOL: EffectiveFindingProtocol = {
  mode: "hybrid",
  default_profile: "security.vulnerability",
  allowed_profiles: [
    "security.vulnerability",
    "security.misconfig",
    "security.secret",
    "quality.bug",
    "compliance.gap",
    "architecture.risk",
    "privacy.issue",
    "perf.regression",
    "supply_chain",
    "general",
    "other",
  ],
  scoring: {
    default_standard: "CVSS",
    default_version: "3.1",
    accepted_versions: ["3.1", "4.0"],
    // Preserve compatibility with existing audit Agents; projects can opt in
    // to mandatory scoring after their prompts emit versioned vectors.
    require_scoring_for_profiles: [],
  },
  display_name: "安全漏洞 · CVSS 3.1（Agent 可选）",
  source: "global",
};

export interface NormalizedFindingScoring {
  profile: string;
  standard: "CVSS";
  version: string;
  vector: string;
  metrics: Record<string, unknown>;
  status: "supported" | "unsupported_version";
  base_score: number | null;
  base_severity: "none" | Severity | null;
  calculator: typeof CVSS_CALCULATOR | null;
  source: "system_recomputed" | "unsupported_raw";
  exploitability_label: "easy" | "medium" | "hard" | null;
  reported_base_score?: number;
}

export interface NormalizedFindingProposal extends Omit<FindingPayload, "profile" | "scoring"> {
  profile: string;
  scoring?: NormalizedFindingScoring;
}

function layerHasValues(layer: FindingProtocolConfig | undefined): boolean {
  return Boolean(layer && Object.values(layer).some((value) => value !== undefined));
}

function overlayProtocol(
  current: EffectiveFindingProtocol,
  layer: FindingProtocolConfig | undefined,
  source: EffectiveFindingProtocol["source"],
): EffectiveFindingProtocol {
  if (!layerHasValues(layer)) return current;
  return {
    mode: layer?.mode ?? current.mode,
    default_profile: layer?.default_profile ?? current.default_profile,
    allowed_profiles: layer?.allowed_profiles ?? current.allowed_profiles,
    scoring: {
      default_standard: layer?.scoring?.default_standard ?? current.scoring.default_standard,
      default_version: layer?.scoring?.default_version ?? current.scoring.default_version,
      accepted_versions: layer?.scoring?.accepted_versions ?? current.scoring.accepted_versions,
      require_scoring_for_profiles:
        layer?.scoring?.require_scoring_for_profiles ?? current.scoring.require_scoring_for_profiles,
    },
    display_name: layer?.display_name ?? current.display_name,
    source,
  };
}

/** Resolve scalar and list replacement semantics: task > project > global. */
export function resolveFindingProtocol(
  globalConfig?: FindingProtocolConfig,
  projectConfig?: FindingProtocolConfig,
  taskConfig?: FindingProtocolConfig,
): EffectiveFindingProtocol {
  let effective = overlayProtocol(DEFAULT_FINDING_PROTOCOL, globalConfig, "global");
  effective = overlayProtocol(effective, projectConfig, "project");
  effective = overlayProtocol(effective, taskConfig, "task");

  effective.allowed_profiles = [...new Set(effective.allowed_profiles)];
  effective.scoring.accepted_versions = [...new Set(effective.scoring.accepted_versions)];
  effective.scoring.require_scoring_for_profiles = [...new Set(effective.scoring.require_scoring_for_profiles)];
  if (!effective.allowed_profiles.includes(effective.default_profile)) {
    throw new Error("finding protocol default_profile must be included in allowed_profiles");
  }
  return effective;
}

export function selectFindingProfile(
  protocol: EffectiveFindingProtocol,
  requestedProfile?: string,
): string {
  const profile = requestedProfile ?? protocol.default_profile;
  if (protocol.mode === "fixed" && requestedProfile && requestedProfile !== protocol.default_profile) {
    throw new Error(`finding profile is fixed to ${protocol.default_profile}`);
  }
  if (!protocol.allowed_profiles.includes(profile)) {
    throw new Error(`finding profile ${profile} is not allowed by the effective protocol`);
  }
  return protocol.mode === "fixed" ? protocol.default_profile : profile;
}

function severityForScore(score: number): NormalizedFindingScoring["base_severity"] {
  if (score === 0) return "none";
  if (score < 4) return "low";
  if (score < 7) return "medium";
  if (score < 9) return "high";
  return "critical";
}

function calculateCvss(version: "4.0" | "3.1", vector: string): { score: number; vector: string } {
  const calculator = version === "4.0" ? new cvss.Cvss4P0(vector) : new cvss.Cvss3P1(vector);
  const result = calculator.calculateScores();
  const score = version === "4.0" ? result.overall : result.base;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error("CVSS calculator returned an invalid base score");
  }
  return { score, vector: result.vector };
}

function exploitabilityForVector(version: "4.0" | "3.1", vector: string): "easy" | "medium" | "hard" {
  const metrics = new Map(
    vector
      .split("/")
      .slice(1)
      .map((part) => part.split(":", 2) as [string, string]),
  );
  if (version === "4.0") {
    if (
      metrics.get("AV") === "N" &&
      metrics.get("AC") === "L" &&
      metrics.get("AT") === "N" &&
      metrics.get("PR") === "N" &&
      metrics.get("UI") === "N"
    ) return "easy";
    if (
      metrics.get("AC") === "H" ||
      metrics.get("AT") === "P" ||
      metrics.get("PR") === "H" ||
      ["P", "A"].includes(metrics.get("UI") ?? "")
    ) return "hard";
    return "medium";
  }
  if (
    metrics.get("AV") === "N" &&
    metrics.get("AC") === "L" &&
    metrics.get("PR") === "N" &&
    metrics.get("UI") === "N"
  ) return "easy";
  if (metrics.get("AC") === "H" || metrics.get("PR") === "H" || metrics.get("UI") === "R") return "hard";
  return "medium";
}

export function normalizeFindingScoring(
  profile: string,
  proposal: FindingScoringProposal,
): NormalizedFindingScoring {
  if (!proposal.vector.startsWith(`CVSS:${proposal.version}/`)) {
    throw new Error("CVSS vector prefix must match scoring.version");
  }
  const metrics = proposal.metrics ?? {};
  if (proposal.version !== "4.0" && proposal.version !== "3.1") {
    return {
      profile,
      standard: "CVSS",
      version: proposal.version,
      vector: proposal.vector,
      metrics,
      status: "unsupported_version",
      base_score: null,
      base_severity: null,
      calculator: null,
      source: "unsupported_raw",
      exploitability_label: null,
      ...(proposal.base_score === undefined ? {} : { reported_base_score: proposal.base_score }),
    };
  }

  let calculated: { score: number; vector: string };
  try {
    calculated = calculateCvss(proposal.version, proposal.vector);
  } catch {
    throw new Error(`invalid CVSS ${proposal.version} vector`);
  }
  return {
    profile,
    standard: "CVSS",
    version: proposal.version,
    vector: calculated.vector,
    metrics,
    status: "supported",
    base_score: calculated.score,
    base_severity: severityForScore(calculated.score),
    calculator: CVSS_CALCULATOR,
    source: "system_recomputed",
    exploitability_label: exploitabilityForVector(proposal.version, calculated.vector),
    ...(proposal.base_score === undefined ? {} : { reported_base_score: proposal.base_score }),
  };
}

export function normalizeFindingProposal(
  proposal: EmitFindingPayload | FindingPayload,
  protocol: EffectiveFindingProtocol,
): NormalizedFindingProposal {
  if (typeof proposal.title !== "string") throw new Error("finding title is required");
  const { profile: _requestedProfile, scoring: _proposedScoring, ...restWithPayloadFile } = proposal;
  const { payload_file: _payloadFile, ...rest } = restWithPayloadFile as typeof restWithPayloadFile & { payload_file?: unknown };
  const profile = selectFindingProfile(protocol, proposal.profile);
  if (proposal.scoring && !protocol.scoring.accepted_versions.includes(proposal.scoring.version)) {
    throw new Error(`CVSS version ${proposal.scoring.version} is not accepted by the effective protocol`);
  }
  if (protocol.scoring.require_scoring_for_profiles.includes(profile) && !proposal.scoring) {
    throw new Error(`finding profile ${profile} requires scoring`);
  }
  return {
    ...rest,
    title: proposal.title,
    suggest_verify: rest.suggest_verify ?? false,
    profile,
    ...(proposal.scoring ? { scoring: normalizeFindingScoring(profile, proposal.scoring) } : {}),
  };
}
