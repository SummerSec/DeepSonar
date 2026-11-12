import type { KnowledgeJobAssignment, PlatformToolName } from "@deepsonar/shared-types";
import type { AgentRuntimeSnapshot } from "../role-runtime-snapshot/index.js";
import { canonical, sha256 } from "./types.js";
import { isolateKnowledgeConfiguration } from "./job-isolation-config.js";

const baseTools = ["emit_progress", "mark_job_done", "request_human", "read_knowledge_input", "get_knowledge_receipt"];
const stageTools = {
  maker: ["search_project_knowledge", "read_project_memory", "search_skills", "list_available_skills", "pull_skill", "propose_project_knowledge"],
  trial: ["publish_shared_asset", "emit_fact"],
  evaluator: ["submit_knowledge_evaluation"],
  reviewer: ["review_project_knowledge"],
};

/** Creation-time restriction only. Existing immutable Jobs are never rewritten. */
export function isolateKnowledgeJob<T extends AgentRuntimeSnapshot>(snapshot: T, assignment?: KnowledgeJobAssignment): T {
  if (!assignment || (assignment.stage !== "trial" && assignment.source_mode !== "project_collection")) return snapshot;
  const tools = new Set([...baseTools, ...stageTools[assignment.stage]]);
  const emptyCatalog = { entries: [], hash: sha256("[]") };
  return {
    ...snapshot,
    // This is an intersection with admission, never a grant of missing role capabilities.
    platform_tools: snapshot.platform_tools.filter(tool => tools.has(tool)) as PlatformToolName[],
    network_policy: { allow_egress: false }, shared_assets: [],
    modules: [], module_selectors: [], expanded_modules: [], missing_modules: [],
    skills: [], commands: [], mcps: [], subagents: [], instructions_markdown: null,
    env_vars: {}, env_keys: [],
    ...isolateKnowledgeConfiguration(snapshot),
    ...(assignment.stage === "trial" ? {
      project_knowledge_catalog: emptyCatalog,
      job_skill_catalog: { schema: "deepsonar.job-skill-catalog/v1" as const,
        project_id: snapshot.job_skill_catalog.project_id, sources: [], extensions: [],
        catalog_hash: sha256(canonical({ project_id: snapshot.job_skill_catalog.project_id, sources: [], extensions: [] })) },
    } : {}),
  };
}
