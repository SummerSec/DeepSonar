import { sql } from "../../db.js";
import { STRONG_RELATION_RULE_VERSION } from "./identity.js";

type Db = typeof sql;

export async function requestStrongRelationRebuild(projectId: string, db: Db = sql): Promise<void> {
  await db`INSERT INTO project_finding_relation_work(project_id, rule_version)
    VALUES (${projectId}::uuid, ${STRONG_RELATION_RULE_VERSION})
    ON CONFLICT(project_id) DO UPDATE SET generation=gen_random_uuid(),
      rule_version=EXCLUDED.rule_version, cursor_id=NULL, status='pending', attempts=0,
      error_code=NULL, next_run_at=now(), updated_at=now()`;
}
