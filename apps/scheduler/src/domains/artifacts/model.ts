import type {
  ArtifactClaimInput,
  ArtifactEvidenceInput,
  ArtifactInput,
  ArtifactRelationInput,
  FactPayload,
  VerificationEvidence,
} from "@deepsonar/shared-types";
import type { NormalizedFindingProposal } from "../../finding-protocol.js";

export const ARTIFACT_SCHEMA_VERSION_DEFAULT = "1";
export const ARTIFACT_KIND_OBSERVATION = "observation";

export interface ArtifactClaimWrite {
  statement: string;
  subject: ArtifactClaimInput["subject"];
  expected?: string;
  actual?: string;
  status: NonNullable<ArtifactClaimInput["status"]>;
  evidence_refs: string[];
}

export interface ArtifactEvidenceWrite {
  kind: string;
  statement: string;
  polarity: NonNullable<ArtifactEvidenceInput["polarity"]>;
  uri?: string;
  sha256?: string;
}

export interface ArtifactWrite {
  kind: string;
  schema_version: string;
  artifact_key?: string;
  claims: ArtifactClaimWrite[];
  evidence: ArtifactEvidenceWrite[];
  relations: ArtifactRelationInput[];
  extensions: Record<string, Record<string, unknown>>;
  body: Record<string, unknown>;
}

export function findingArtifactKey(fingerprint: string): string {
  return `finding:${fingerprint}`;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function verificationClaimStatus(outcome: VerificationEvidence["outcome"]): ArtifactClaimWrite["status"] {
  if (outcome === "supports") return "supported";
  if (outcome === "refutes") return "contradicted";
  return "unknown";
}

function verificationPolarity(outcome: VerificationEvidence["outcome"]): ArtifactEvidenceWrite["polarity"] {
  if (outcome === "supports") return "supports";
  if (outcome === "refutes") return "contradicts";
  return "unknown";
}

function normalizeClaim(claim: ArtifactClaimInput): ArtifactClaimWrite {
  return {
    statement: claim.statement,
    subject: claim.subject,
    expected: claim.expected,
    actual: claim.actual,
    status: claim.status ?? "unknown",
    evidence_refs: claim.evidence_refs ?? [],
  };
}

function normalizeEvidence(item: ArtifactEvidenceInput): ArtifactEvidenceWrite {
  return {
    kind: item.kind ?? ARTIFACT_KIND_OBSERVATION,
    statement: item.statement,
    polarity: item.polarity ?? "unknown",
    uri: item.uri,
    sha256: item.sha256,
  };
}

export function factProposalToArtifact(fact: {
  title: string;
  description: string;
  quantities?: FactPayload["quantities"];
  verification?: VerificationEvidence;
  artifact?: ArtifactInput;
}): ArtifactWrite {
  const input = fact.artifact ?? {};
  const claims = (input.claims ?? []).map(normalizeClaim);
  const evidence = (input.evidence ?? []).map(normalizeEvidence);
  if (claims.length === 0) {
    claims.push({
      statement: fact.description,
      subject: { label: fact.title },
      status: "unknown",
      evidence_refs: [],
    });
  }
  if (fact.verification) {
    claims.push({
      statement: fact.description,
      subject: { type: "finding", id: fact.verification.finding_id },
      expected: fact.verification.expected,
      actual: fact.verification.actual,
      status: verificationClaimStatus(fact.verification.outcome),
      evidence_refs: [],
    });
    evidence.push({
      kind: fact.verification.evidence_kind === "review" ? "review" : "test",
      statement: fact.verification.actual ?? fact.description,
      polarity: verificationPolarity(fact.verification.outcome),
    });
  }
  return {
    kind: input.kind ?? ARTIFACT_KIND_OBSERVATION,
    schema_version: input.schema_version ?? ARTIFACT_SCHEMA_VERSION_DEFAULT,
    artifact_key: input.artifact_key,
    claims,
    evidence,
    relations: input.relations ?? [],
    extensions: input.extensions ?? {},
    body: compact({
      title: fact.title,
      description: fact.description,
      quantities: fact.quantities && fact.quantities.length > 0 ? fact.quantities : undefined,
    }),
  };
}

export function findingProposalToArtifact(finding: NormalizedFindingProposal): ArtifactWrite {
  const profile = finding.profile;
  const evidenceRefs = finding.evidence_refs ?? [];
  return {
    kind: profile,
    schema_version: ARTIFACT_SCHEMA_VERSION_DEFAULT,
    claims: [
      {
        statement: finding.summary ?? finding.title,
        subject: compact({
          type: "location",
          location: finding.location,
          label: finding.title,
        }),
        status: "unknown",
        evidence_refs: evidenceRefs,
      },
    ],
    evidence: evidenceRefs.map((ref) => ({
      kind: "reference",
      statement: ref,
      polarity: "unknown" as const,
      uri: ref,
    })),
    relations: [],
    extensions: {
      [profile]: compact({
        title: finding.title,
        category: finding.category,
        tags: finding.tags,
        severity: finding.severity,
        scoring: finding.scoring,
        location: finding.location,
        rule_id: finding.rule_id,
        quantities: finding.quantities,
      }),
    },
    body: compact({
      title: finding.title,
      summary: finding.summary,
      profile,
    }),
  };
}
