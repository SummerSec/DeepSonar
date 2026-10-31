export {
  FINDING_RESEARCH_BATCH_LIMIT,
  FINDING_RESEARCH_MODEL,
  FINDING_RESEARCH_PROMPT_REVISION,
  FindingResearchJudgeError,
  clusterCandidates,
  heuristicCompare,
  rankCanonicalSet,
  runResearchPipeline,
  type ResearchCandidate,
  type SemanticJudge,
} from "./policy.js";
export {
  projectFindingResearch,
  runFindingResearch,
  runFindingResearchBestEffort,
  type FindingResearchRunResult,
} from "./application.js";
export { registerFindingResearchRoutes } from "./routes.js";


// Bounded counter-evidence / hypothesis revision (#579) — Verify stays Fact-only.
export {
  RESEARCH_HYPOTHESIS_STRATEGY_ID, RESEARCH_HYPOTHESIS_STRATEGY_VERSION, researchInputFingerprint, argumentsByKind, evaluateResearchStance, deriveHypothesisAfterRefute, projectResearchDecisionToHub, frozenResearchHypothesisMeta
} from "../../research-hypothesis-loop.js";
export type {
  ResearchCitation, ResearchArgumentKind, ResearchArgument, HypothesisStatus, ResearchHypothesis, ResearchNextAction, ResearchStanceDecision
} from "../../research-hypothesis-loop.js";
