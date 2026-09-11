/**
 * Semantic dedupe + relative priority (#448).
 *
 * Pure scheduler policy: never reads or writes verify_status, Fact gates,
 * severity mutations, or report convergence blockers.
 */

export const FINDING_RESEARCH_PROMPT_REVISION = "finding-research-v1";
export const FINDING_RESEARCH_MODEL = "heuristic";
export const FINDING_RESEARCH_BATCH_LIMIT = 8;
export const FINDING_RESEARCH_MAX_BATCHES = 8;
export const FINDING_RESEARCH_MERGE_THRESHOLD = 0.42;

export class FindingResearchJudgeError extends Error {
  readonly code = "finding_research_failed";
  constructor(message: string) {
    super(message);
    this.name = "FindingResearchJudgeError";
  }
}

export interface ResearchCandidate {
  id: string;
  title: string;
  location: string | null;
  summary: string | null;
  category: string | null;
  profile: string;
  severity: string | null;
  evidenceRefs: readonly string[];
  createdAt: string;
}

export interface ResearchMembership {
  findingId: string;
  clusterId: string;
  canonicalFindingId: string;
  isCanonical: boolean;
  dedupeReason: string;
}

export interface PriorityAssignment {
  findingId: string;
  score: number;
  reason: string;
}

export interface SemanticJudge {
  compare(candidate: ResearchCandidate, anchors: readonly ResearchCandidate[]): {
    matchAnchorId: string | null;
    reason: string;
  };
}

export interface ClusterBatchResult {
  assignments: ResearchMembership[];
  newAnchors: ResearchCandidate[];
  processedIds: string[];
  remainingIds: string[];
}

export interface ResearchPipelineResult {
  assignments: ResearchMembership[];
  priorities: PriorityAssignment[];
  remainingIds: string[];
  model: string;
  promptRevision: string;
}

const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "of", "for", "to", "and", "or", "via",
  "with", "from", "into", "by", "is", "a", "possible", "potential", "likely",
  "found", "issue", "vulnerability", "vuln", "bug",
]);

const PHRASE_ALIASES: Array<[RegExp, string]> = [
  [/sql\s*injection|sql-injection/g, "sqli"],
  [/cross[\s-]*site\s*scripting/g, "xss"],
  [/remote\s*code\s*execution/g, "rce"],
  [/server[\s-]*side\s*request\s*forgery/g, "ssrf"],
  [/(?:path|directory)\s*traversal|local\s*file\s*inclusion/g, "lfi"],
  [/xml\s*external\s*entity/g, "xxe"],
  [/insecure\s*direct\s*object/g, "idor"],
];

export function normalizeResearchText(value: string | null | undefined): string {
  let text = String(value ?? "").toLowerCase();
  for (const [pattern, alias] of PHRASE_ALIASES) text = text.replace(pattern, alias);
  return text.replace(/[^a-z0-9.\-_/]+/g, " ").trim();
}

export function researchTokens(...parts: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  for (const part of parts) {
    for (const token of normalizeResearchText(part).split(/\s+/)) {
      if (token && !STOPWORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let inter = 0;
  for (const token of left) if (right.has(token)) inter += 1;
  return inter / (left.size + right.size - inter);
}

function locationParts(location: string | null | undefined): { exact: string; file: string } {
  const normalized = normalizeResearchText(location);
  const file = normalized.replace(/:\d+(?::\d+)?$/, "");
  return { exact: normalized, file };
}

export function semanticSimilarity(left: ResearchCandidate, right: ResearchCandidate): number {
  const titleScore = jaccard(
    researchTokens(left.title, left.summary),
    researchTokens(right.title, right.summary),
  );
  const leftLoc = locationParts(left.location);
  const rightLoc = locationParts(right.location);
  const locationScore = leftLoc.exact && leftLoc.exact === rightLoc.exact
    ? 1
    : leftLoc.file && leftLoc.file === rightLoc.file
      ? 0.5
      : 0;
  const categoryScore = left.category && right.category
    ? left.category === right.category ? 1 : 0
    : 0.5;
  return 0.55 * titleScore + 0.3 * locationScore + 0.15 * categoryScore;
}

export function heuristicCompare(
  candidate: ResearchCandidate,
  anchors: readonly ResearchCandidate[],
): { matchAnchorId: string | null; reason: string } {
  let best: { id: string; score: number } | null = null;
  for (const anchor of anchors) {
    const score = semanticSimilarity(candidate, anchor);
    if (!best || score > best.score) best = { id: anchor.id, score };
  }
  if (!best || best.score < FINDING_RESEARCH_MERGE_THRESHOLD) {
    return {
      matchAnchorId: null,
      reason: `no semantic anchor above ${FINDING_RESEARCH_MERGE_THRESHOLD}; grow canonical set`,
    };
  }
  return {
    matchAnchorId: best.id,
    reason: `same root cause as ${best.id} (score ${best.score.toFixed(2)}); keep source finding`,
  };
}

export function clusterCandidates(
  candidates: readonly ResearchCandidate[],
  anchors: readonly ResearchCandidate[],
  options?: { batchLimit?: number; judge?: SemanticJudge },
): ClusterBatchResult {
  const batchLimit = options?.batchLimit ?? FINDING_RESEARCH_BATCH_LIMIT;
  const judge = options?.judge ?? { compare: heuristicCompare };
  const queued = candidates.slice();
  const processed = queued.slice(0, batchLimit);
  const remainingIds = queued.slice(batchLimit).map((item) => item.id);
  const liveAnchors = [...anchors];
  const assignments: ResearchMembership[] = [];
  const newAnchors: ResearchCandidate[] = [];

  for (const candidate of processed) {
    const decision = judge.compare(candidate, liveAnchors);
    if (decision.matchAnchorId) {
      const anchor = liveAnchors.find((item) => item.id === decision.matchAnchorId);
      if (!anchor) {
        throw new FindingResearchJudgeError(`judge matched unknown anchor ${decision.matchAnchorId}`);
      }
      assignments.push({
        findingId: candidate.id,
        clusterId: `cluster:${anchor.id}`,
        canonicalFindingId: anchor.id,
        isCanonical: false,
        dedupeReason: decision.reason,
      });
      continue;
    }
    liveAnchors.push(candidate);
    newAnchors.push(candidate);
    assignments.push({
      findingId: candidate.id,
      clusterId: `cluster:${candidate.id}`,
      canonicalFindingId: candidate.id,
      isCanonical: true,
      dedupeReason: decision.reason,
    });
  }

  return { assignments, newAnchors, processedIds: processed.map((item) => item.id), remainingIds };
}

const SEVERITY_HINT: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function attentionRaw(finding: ResearchCandidate): number {
  const severityHint = SEVERITY_HINT[String(finding.severity ?? "")] ?? 2.5;
  return severityHint * 10 + Math.min(finding.evidenceRefs.length, 5) * 2;
}

export function rankCanonicalSet(canonicals: readonly ResearchCandidate[]): PriorityAssignment[] {
  if (canonicals.length === 0) return [];
  const ranked = [...canonicals].sort((left, right) => {
    const delta = attentionRaw(right) - attentionRaw(left);
    if (delta !== 0) return delta;
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
  const maxRaw = Math.max(...ranked.map(attentionRaw));
  return ranked.map((finding, index) => {
    const raw = attentionRaw(finding);
    const score = maxRaw === 0 ? 50 : Math.round((100 * raw) / maxRaw);
    return {
      findingId: finding.id,
      score,
      reason: `相对注意力 ${index + 1}/${ranked.length}；severity 仅作 hint=${finding.severity ?? "unset"}，证据 ${finding.evidenceRefs.length} 条。不改 verify_status/severity/报告门禁。`,
    };
  });
}

export function runResearchPipeline(
  unclustered: readonly ResearchCandidate[],
  currentAnchors: readonly ResearchCandidate[],
  options?: { batchLimit?: number; judge?: SemanticJudge; model?: string; promptRevision?: string },
): ResearchPipelineResult {
  const clustered = clusterCandidates(unclustered, currentAnchors, options);
  const nextAnchors = [...currentAnchors, ...clustered.newAnchors];
  return {
    assignments: clustered.assignments,
    priorities: rankCanonicalSet(nextAnchors),
    remainingIds: clustered.remainingIds,
    model: options?.model ?? FINDING_RESEARCH_MODEL,
    promptRevision: options?.promptRevision ?? FINDING_RESEARCH_PROMPT_REVISION,
  };
}
