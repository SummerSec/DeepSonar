/** Offline snapshot: produced in one read-only database transaction by the host.
 * Never persist or log this object: environment/settings/config files can hold secrets.
 * Table rows retain their original keys so removed configuration cannot be hidden
 * by projecting only fields that the target version already understands.
 */
export const PREFLIGHT_SCHEMA = "deepsonar.platform-upgrade-preflight/v1";
export const PREFLIGHT_RESULT_SCHEMA = "deepsonar.platform-upgrade-preflight-result/v1";
export const PREFLIGHT_TABLES = [
  "global_settings", "projects", "agent_roles", "role_configs", "role_config_files",
  "runtime_images", "runtime_image_versions", "credentials",
] as const;
export type PreflightTable = (typeof PREFLIGHT_TABLES)[number];
export type PreflightRow = Record<string, unknown>;
export interface PreflightSnapshot {
  schema: typeof PREFLIGHT_SCHEMA;
  database_schema_version: number;
  target_schema_version: number;
  environment: Record<string, string>;
  /** Private stdin only: never include in reports, logs, plans or journals. */
  master_key_file_content?: string;
  host_files?: import("./platform-upgrade-preflight-environment.js").HostFileEvidence[];
  global_settings: PreflightRow[];
  projects: PreflightRow[];
  agent_roles: PreflightRow[];
  role_configs: PreflightRow[];
  role_config_files: PreflightRow[];
  runtime_images: PreflightRow[];
  runtime_image_versions: PreflightRow[];
  credentials: PreflightRow[];
}
export interface PreflightError { code: string; location: string; message: string }
export interface PreflightResult {
  schema: typeof PREFLIGHT_RESULT_SCHEMA;
  ok: boolean;
  blocking_errors: PreflightError[];
  coverage: string[];
  not_checked: string[];
}
