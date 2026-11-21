import { KNOWLEDGE_OPERATION_IDS, ListAvailableSkillsPayload, PullSkillPayload, SearchSkillsPayload, TASK_KNOWLEDGE_SUGGESTION_OPERATION } from "@deepsonar/shared-types";
import type { PlatformRuntimeHandlerContext } from "../platform-api/registry.js";
import { PlatformRuntimeHandlerError } from "../platform-api/registry.js";
import { availableSkillEntries } from "../../skill-sources.js";
import { loadJobSkillCatalog, pullFrozenJobSkill, JobSkillCatalogError, type FrozenJobSkillCatalog } from "../../job-skill-catalog.js";
import { createProjectKnowledgeApplication, recordKnowledgeUsage, KnowledgeOperationError } from "./application.js";
import { submitTaskKnowledgeSuggestion } from "./closeout-intake.js";
import { projectSkillMetadata, pullProjectSkill, visibleKnowledgeEntries, type FrozenKnowledgeCatalog } from "./catalog-snapshot.js";
import type { KnowledgeDb } from "./types.js";
import { EventRateLimitError } from "../event-ingestion/rate-limit.js";

/** Return only published references from this exact Fact submission and Attempt. */
export async function readTaskSuggestionFactRefs(db: KnowledgeDb, owner: {
  jobId: string; projectId: string; canvasId: string; attemptId: string; eventId: string;
}): Promise<{ knowledge_source_refs: { kind: "fact" | "evidence"; ref: string }[] } | undefined> {
  try {
    const [fact] = await db<{ node_id: string; evidence_ids: string[] }[]>`SELECT a.node_id,
      ARRAY(SELECT ae.id FROM artifact_evidence ae WHERE ae.artifact_id=a.id ORDER BY ae.ordinal LIMIT 4) AS evidence_ids
      FROM artifacts a JOIN canvas_nodes n ON n.id=a.node_id AND n.job_id=a.job_id AND n.canvas_id=a.canvas_id
      JOIN events e ON e.job_id=a.job_id AND e.event_id=a.source_event_id AND e.type='fact'
      WHERE a.job_id=${owner.jobId} AND a.project_id=${owner.projectId} AND a.canvas_id=${owner.canvasId}
        AND a.source_event_id=${owner.eventId} AND e.attempt_id=${owner.attemptId}
        AND a.status='submitted' AND n.node_type='fact' LIMIT 1`;
    if (!fact) return undefined;
    return { knowledge_source_refs: [
      { kind: "fact", ref: fact.node_id },
      ...fact.evidence_ids.map(ref => ({ kind: "evidence" as const, ref })),
    ] };
  } catch {
    // The Fact already committed. A failed reference lookup must not reject it.
    return undefined;
  }
}

export function createKnowledgeRuntime(input: {
  db: KnowledgeDb;
  governanceHash: string;
  taskSuggestionContext?: () => { attemptId: string | null | undefined; secrets: readonly string[] };
}) {
  const application = createProjectKnowledgeApplication(input);
  return async (context: PlatformRuntimeHandlerContext): Promise<Record<string, unknown> | undefined> => {
    const operation = context.operationId;
    if (!(KNOWLEDGE_OPERATION_IDS as readonly string[]).includes(operation)
      && !["list_available_skills", "search_skills", "pull_skill"].includes(operation)) return undefined;
    try {
      if (operation === TASK_KNOWLEDGE_SUGGESTION_OPERATION) {
        if (!input.taskSuggestionContext) throw new PlatformRuntimeHandlerError("OPERATION_HANDLER_NOT_REGISTERED", "Task suggestion requires a running business session");
        return await submitTaskKnowledgeSuggestion(context, input.db, input.taskSuggestionContext());
      }
      if ((KNOWLEDGE_OPERATION_IDS as readonly string[]).includes(operation)) return await application.invoke(context);
      const [job] = await input.db`SELECT j.agent_snapshot_json,a.id AS attempt_id FROM jobs j
        JOIN LATERAL (SELECT id,status,cancel_requested FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) a ON true
        WHERE j.id=${context.jobId} AND j.project_id=${context.projectId} AND j.status='running'
          AND j.lease_expires_at>now() AND a.status='active' AND NOT a.cancel_requested`;
      if (!job) throw new KnowledgeOperationError("KNOWLEDGE_JOB_INACTIVE", "Job or Attempt is no longer active");
      const snapshot = job.agent_snapshot_json as { platform_tools?: string[]; job_skill_catalog?: FrozenJobSkillCatalog; project_knowledge_catalog?: FrozenKnowledgeCatalog };
      if (!snapshot.platform_tools?.includes(operation)) throw new KnowledgeOperationError("KNOWLEDGE_SCOPE_DENIED", "Operation is not allowed for this Job");
      if (operation === "pull_skill") {
        const payload = PullSkillPayload.parse(context.input);
        let skill, entry;
        if (payload.selector.startsWith("project:")) {
          const result = await pullProjectSkill(input.db, context.projectId, snapshot.project_knowledge_catalog, payload.selector, payload.expected_content_hash);
          skill = result.skill; entry = result.entry;
        } else {
          const sources = await loadJobSkillCatalog(input.db as never, context.projectId, snapshot.job_skill_catalog);
          const result = pullFrozenJobSkill(snapshot.job_skill_catalog!, sources, payload.selector, payload.expected_content_hash);
          if (!result.ok) throw new KnowledgeOperationError(result.error_code, result.message);
          skill = result.skill;
        }
        const usage_ref = await recordKnowledgeUsage(input.db, {
          jobId: context.jobId, projectId: context.projectId, attemptId: String(job.attempt_id),
          selector: skill.selector, contentHash: skill.content_hash,
          ...(entry ? { ownerProjectId: entry.owner_project_id, versionId: entry.version_id } : {}),
        });
        return { accepted: true, operation, skill, usage_ref };
      }
      const payload = operation === "search_skills" ? SearchSkillsPayload.parse(context.input) : ListAvailableSkillsPayload.parse(context.input);
      const sources = await loadJobSkillCatalog(input.db as never, context.projectId, snapshot.job_skill_catalog);
      const project = (await visibleKnowledgeEntries(input.db, context.projectId, snapshot.project_knowledge_catalog))
        .filter((entry) => entry.kind === "skill").map(projectSkillMetadata);
      const query = "query" in payload ? payload.query.trim().toLowerCase() : undefined;
      const all = [...availableSkillEntries(sources), ...project]
        .filter((skill) => !query || [skill.selector, skill.name, skill.plugin, skill.description].join(" ").toLowerCase().includes(query))
        .sort((a, b) => a.selector.localeCompare(b.selector));
      const offset = "offset" in payload ? payload.offset ?? 0 : 0, limit = payload.limit ?? 20;
      return { accepted: true, operation, skills: all.slice(offset, offset + limit), total: all.length,
        offset, limit, next_offset: offset + limit < all.length ? offset + limit : null };
    } catch (error) {
      if (operation === TASK_KNOWLEDGE_SUGGESTION_OPERATION && error instanceof EventRateLimitError) {
        throw new PlatformRuntimeHandlerError("OPERATION_REJECTED", error.message, {
          statusCode: 429, errorCode: error.code, retryable: true, details: { ...error.metadata },
        });
      }
      if (error instanceof KnowledgeOperationError || error instanceof JobSkillCatalogError) {
        throw new PlatformRuntimeHandlerError("OPERATION_REJECTED", error.message, {
          statusCode: error instanceof JobSkillCatalogError ? 409 : 422,
          errorCode: error.error_code,
          retryable: error instanceof KnowledgeOperationError && error.category === "transient_retryable",
          category: error instanceof KnowledgeOperationError ? error.category : "permanent_failure",
          next_action: error instanceof KnowledgeOperationError ? error.next_action
            : "Stop Skill access and report the frozen catalog failure to Scheduler; do not replace the snapshot or bypass its authorization.",
          ...(error instanceof KnowledgeOperationError && error.path ? { path: error.path } : {}),
        });
      }
      throw error;
    }
  };
}
