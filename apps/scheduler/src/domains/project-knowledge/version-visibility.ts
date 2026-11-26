import { actorHasScope, type Actor } from "../../auth.js";
import type { KnowledgeDb } from "./types.js";

/**
 * #1286：已发布版本的「来源可见性」判定，直接下推到 SQL。
 *
 * 来源只用于定位（evidence→artifacts.job_id、fact→canvas_nodes.job_id、task→jobs），
 * 能否读沿用来源原有授权：来源属治理资料时，读者 Job 的冻结清单必须逐字包含
 * `kind:UUID` + `content_hash`，且当前阶段在该来源的 audience 内。
 * 来源无法定位（引用被删）按原语义隐藏；普通业务来源不受影响。
 */
export async function readableVersionKeysJson(db: KnowledgeDb, actor: Actor | undefined,
  projectId: string): Promise<string> {
  // 能读原始资料的人沿用其既有 scope，不必再持有治理 Job 的冻结清单。
  if (actor && actorHasScope(actor, "tasks:read")) return "*";
  const keys: string[] = [];
  if (actor) {
    const rows = await db`SELECT stage, input_manifest_json FROM project_knowledge_job_assignments
      WHERE job_id=${actor.id} AND project_id=${projectId}`;
    for (const row of rows) {
      const stage = String(row.stage);
      const manifest = Array.isArray(row.input_manifest_json) ? row.input_manifest_json : [];
      for (const entry of manifest) {
        if (typeof entry !== "object" || entry === null) continue;
        const value = entry as Record<string, unknown>;
        const audience = Array.isArray(value.audience) ? value.audience.map(String) : [];
        if (typeof value.input_ref !== "string" || typeof value.content_hash !== "string") continue;
        if (!audience.includes(stage)) continue;
        keys.push(`${value.input_ref}|${value.content_hash}`);
      }
    }
  }
  // 用控制字符拼成一条文本参数，避免 jsonb 解析路径（标量/数组形状都曾踩过）。
  return keys.join("\u0001");
}

/** 该版本对当前读者是否可见；`v` 是查询里的版本别名。
 * 先验证来源存在且属于同一项目，再区分普通共享来源（直接可见）与治理来源（要求清单与受众匹配）；
 * 来源缺失或跨项目一律按原有安全语义隐藏。`keysText === '*'` 只跳过来源清单比对，不跳过归属校验。 */
export function readableVersionSources(db: KnowledgeDb, keysText: string) {
  return db`NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.sources_json) = 'array' THEN v.sources_json ELSE '[]'::jsonb END) AS s
      LEFT JOIN LATERAL (
        SELECT
          CASE s->>'kind'
            WHEN 'evidence' THEN (
              SELECT ar.project_id FROM artifact_evidence ev JOIN artifacts ar ON ar.id = ev.artifact_id
              WHERE CASE WHEN (s->>'ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ev.id = (s->>'ref')::uuid END
            )
            WHEN 'fact' THEN (
              SELECT c.project_id FROM canvas_nodes cn JOIN canvases c ON c.id = cn.canvas_id
              WHERE CASE WHEN (s->>'ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN cn.id = (s->>'ref')::uuid END
            )
            ELSE (
              SELECT j.project_id FROM jobs j
              WHERE CASE WHEN (s->>'job_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN j.id = (s->>'job_id')::uuid END
            )
          END AS owner_project,
          CASE s->>'kind'
            WHEN 'evidence' THEN (
              SELECT ar.job_id FROM artifact_evidence ev JOIN artifacts ar ON ar.id = ev.artifact_id
              WHERE CASE WHEN (s->>'ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ev.id = (s->>'ref')::uuid END
            )
            WHEN 'fact' THEN (
              SELECT cn.job_id FROM canvas_nodes cn
              WHERE CASE WHEN (s->>'ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN cn.id = (s->>'ref')::uuid END
            )
            ELSE (
              SELECT j.id FROM jobs j
              WHERE CASE WHEN (s->>'job_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN j.id = (s->>'job_id')::uuid END
            )
          END AS owner_job
      ) r ON true
      WHERE s->>'kind' IN ('fact','evidence','task')
        AND (
          r.owner_project IS NULL
          OR r.owner_project <> v.project_id
          OR (
            r.owner_job IS NOT NULL
            AND EXISTS (SELECT 1 FROM project_knowledge_job_assignments a
              WHERE a.project_id = v.project_id AND a.job_id = r.owner_job)
            AND ${keysText} <> '*'
            AND NOT (
              (s->>'kind') || ':' || COALESCE(s->>'ref', s->>'job_id') || '|' || COALESCE(s->>'content_hash','')
              = ANY(string_to_array(${keysText}, chr(1)))
            )
          )
        )
    )`;
}
