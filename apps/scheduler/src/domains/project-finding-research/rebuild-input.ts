export class FeatureRebuildInputError extends Error {
  constructor(readonly code: "DATABASE_URL_REQUIRED" | "INVALID_DATABASE_URL" | "INVALID_REBUILD_ARGUMENTS") {
    super(code);
    this.name = "FeatureRebuildInputError";
  }
}

/** Resolve neither an implicit database nor a project from defaults/configuration. */
export function parseFeatureRebuildInput(args: readonly string[], databaseUrl: string | undefined): {
  projectId: string; databaseUrl: string; mode: "rebuild" | "prune_inactive";
} {
  if (!databaseUrl?.trim()) throw new FeatureRebuildInputError("DATABASE_URL_REQUIRED");
  let parsed: URL;
  try { parsed = new URL(databaseUrl.trim()); }
  catch { throw new FeatureRebuildInputError("INVALID_DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new FeatureRebuildInputError("INVALID_DATABASE_URL");
  }
  const argv = args[0] === "--" ? args.slice(1) : args;
  let projectId: string | undefined;
  let prune = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--project-id" && projectId === undefined && argv[index + 1] !== undefined) {
      projectId = argv[++index];
    } else if (argv[index] === "--prune-inactive" && !prune) {
      prune = true;
    } else {
      throw new FeatureRebuildInputError("INVALID_REBUILD_ARGUMENTS");
    }
  }
  if (!projectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new FeatureRebuildInputError("INVALID_REBUILD_ARGUMENTS");
  }
  return { projectId: projectId.toLowerCase(), databaseUrl: databaseUrl.trim(), mode: prune ? "prune_inactive" : "rebuild" };
}
