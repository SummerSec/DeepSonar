import { pathToFileURL } from "node:url";
import { SCHEMA_VERSION } from "../../schema-version.js";
import { FeatureRebuildInputError, parseFeatureRebuildInput } from "./rebuild-input.js";

/** Operator CLI: database authorization is supplied explicitly, as for db:rebuild.
 * Never loads database defaults, changes maintenance phase, or calls a model/API. */
export async function runFeatureRebuildCLI(args: readonly string[]): Promise<{ project_id: string; generation: string } | { project_id: string; pruned_count: number }> {
  // Validate before importing db/config, which otherwise loads repository .env files.
  const input = parseFeatureRebuildInput(args, process.env.DATABASE_URL);
  const identity = {
    generation: process.env.DEEPSONAR_UPGRADE_GENERATION ?? "",
    version: process.env.DEEPSONAR_VERSION ?? "",
  };
  process.env.DATABASE_URL = input.databaseUrl;
  const { sql } = await import("../../db.js");
  try {
    const [{ requestFeatureRebuild, pruneInactiveFeatureBatch }, { maintenanceIdentityMatches }] = await Promise.all([
      import("./store.js"), import("../../platform-maintenance.js"),
    ]);
    return await sql.begin(async (raw) => {
      const tx = raw as unknown as typeof sql;
      await tx`SET LOCAL statement_timeout = '3000ms'`;
      const [state] = await tx`SELECT phase, generation, runtime_role, target_version, CURRENT_USER AS current_role
        FROM platform_upgrade_state WHERE id = 'global' FOR SHARE`;
      if (!state || state.phase !== "active" || !maintenanceIdentityMatches(state as never, identity)) {
        throw new Error("FEATURE_REBUILD_MAINTENANCE_DENIED");
      }
      const [schema] = await tx`SELECT version FROM schema_meta WHERE id = 'global'`;
      if (Number(schema?.version) !== SCHEMA_VERSION) throw new Error("FEATURE_REBUILD_SCHEMA_MISMATCH");
      const [project] = await tx`SELECT id FROM projects WHERE id = ${input.projectId}::uuid FOR SHARE`;
      if (!project) throw new Error("FEATURE_REBUILD_PROJECT_NOT_FOUND");
      if (input.mode === "prune_inactive") {
        return { project_id: input.projectId, pruned_count: await pruneInactiveFeatureBatch(input.projectId, raw) };
      }
      await requestFeatureRebuild(input.projectId, tx);
      const [work] = await tx`SELECT generation FROM project_finding_feature_work WHERE project_id = ${input.projectId}::uuid`;
      return { project_id: input.projectId, generation: String(work.generation) };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runFeatureRebuildCLI(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error: unknown) => {
    const operationalCodes = ["FEATURE_REBUILD_MAINTENANCE_DENIED", "FEATURE_REBUILD_SCHEMA_MISMATCH", "FEATURE_REBUILD_PROJECT_NOT_FOUND"];
    const code = error instanceof FeatureRebuildInputError ? error.code
      : error instanceof Error && operationalCodes.includes(error.message) ? error.message : "FEATURE_REBUILD_FAILED";
    // Raw database errors and connection strings may contain secrets.
    console.error(code);
    process.exitCode = 1;
  });
}
