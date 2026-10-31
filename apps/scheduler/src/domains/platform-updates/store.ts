import type { sql as Sql } from "../../db.js";
import {
  PLATFORM_UPDATE_CHECK_ID,
  PLATFORM_UPDATE_CHANGELOG_MAX_CHARS,
  PLATFORM_UPDATE_COMMIT_MAX_CHARS,
  PLATFORM_UPDATE_ERROR_MAX_CHARS,
  PLATFORM_UPDATE_VERSION_MAX_CHARS,
  readPlatformUpdateCheckRow,
  type PlatformUpdateDecision,
  type PlatformUpdateStatus,
} from "./model.js";

type Db = typeof Sql;

export async function readPlatformUpdateCheck(db: Db): Promise<PlatformUpdateStatus> {
  const [row] = await db`
    SELECT checked_at, current_version, available_version, available_commit_sha,
           available_schema_version, changelog_url, update_available, schema_rebuild_needed,
           check_error, registry_source
    FROM platform_update_checks WHERE id = ${PLATFORM_UPDATE_CHECK_ID}`;
  return readPlatformUpdateCheckRow(row as Record<string, unknown> | undefined);
}

/** Upsert the latest check. Never throws on missing table in unit tests — callers wrap. */
export async function writePlatformUpdateCheck(db: Db, decision: PlatformUpdateDecision): Promise<PlatformUpdateStatus> {
  const [row] = await db`
    INSERT INTO platform_update_checks (
      id, checked_at, current_version, available_version, available_commit_sha,
      available_schema_version, changelog_url, update_available, schema_rebuild_needed,
      check_error, registry_source
    ) VALUES (
      ${PLATFORM_UPDATE_CHECK_ID},
      now(),
      ${decision.current_version.slice(0, PLATFORM_UPDATE_VERSION_MAX_CHARS)},
      ${decision.available_version},
      ${decision.available_commit_sha ? decision.available_commit_sha.slice(0, PLATFORM_UPDATE_COMMIT_MAX_CHARS) : null},
      ${decision.available_schema_version},
      ${decision.changelog_url ? decision.changelog_url.slice(0, PLATFORM_UPDATE_CHANGELOG_MAX_CHARS) : null},
      ${decision.update_available},
      ${decision.schema_rebuild_needed},
      ${decision.check_error ? decision.check_error.slice(0, PLATFORM_UPDATE_ERROR_MAX_CHARS) : null},
      ${decision.registry_source}
    )
    ON CONFLICT (id) DO UPDATE SET
      checked_at = EXCLUDED.checked_at,
      current_version = EXCLUDED.current_version,
      available_version = EXCLUDED.available_version,
      available_commit_sha = EXCLUDED.available_commit_sha,
      available_schema_version = EXCLUDED.available_schema_version,
      changelog_url = EXCLUDED.changelog_url,
      update_available = EXCLUDED.update_available,
      schema_rebuild_needed = EXCLUDED.schema_rebuild_needed,
      check_error = EXCLUDED.check_error,
      registry_source = EXCLUDED.registry_source
    RETURNING checked_at, current_version, available_version, available_commit_sha,
              available_schema_version, changelog_url, update_available, schema_rebuild_needed,
              check_error, registry_source`;
  return readPlatformUpdateCheckRow(row as Record<string, unknown> | undefined);
}
