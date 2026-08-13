import type { RuntimeImageSnapshot } from "../../runtime-images.js";
import type { MissingModule } from "../../skill-sources.js";
import type { PlatformToolName } from "@deepsonar/shared-types";
import type { SharedAssetSelection } from "../shared-assets/application.js";
import type { AgentCliRuntimeSnapshot } from "@deepsonar/runtime-sandbox";
import type { EffectiveSandboxLimits, FrozenNetworkPolicy } from "./sandbox-limits.js";

/** Minimal transaction-shaped client accepted by the snapshot application. */
export type RoleRuntimeSnapshotTransaction = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  json?: (value: unknown) => unknown;
};

export interface RoleRuntimeSnapshotResult {
  name: string;
  role_kind: "role" | "hub" | "system";
  ui_color: string | null;
  agent_cli: string;
  /** Immutable adapter implementation/capability contract captured at Job creation. */
  agent_runtime: AgentCliRuntimeSnapshot;
  model: string | null;
  reasoning: "low" | "medium" | "high" | "xhigh" | null;
  env_vars: Record<string, string>;
  env_keys: string[];
  credential_id: string | null;
  credential_name: string | null;
  credential_provider: string | null;
  modules: string[];
  module_selectors: string[];
  expanded_modules: {
    source_id: string;
    module_id: string;
    kind: "skill" | "command";
    plugin: string;
    name: string;
    description: string;
    content_hash: string;
  }[];
  missing_modules: MissingModule[];
  module_content_hash: string;
  skill_revisions: { source_id: string; commit_sha: string | null; content_hash: string | null }[];
  skills: unknown[];
  commands: unknown[];
  mcps: unknown[];
  subagents: unknown[];
  role_description: string;
  instructions_markdown: string | null;
  platform_tools: PlatformToolName[];
  /** 最终冻结的通用客户端上下文预算；null 表示 Provider/CLI 默认值。 */
  context_window_tokens: number | null;
  /** Full provider settings profile frozen with the Job and materialized verbatim for the CLI. */
  settings_config_json: unknown;
  config_files: { path: string; content: string; content_sha256: string }[];
  role_config_id: string | null;
  role_config_version: number | null;
  runtime_image_key: string | null;
  runtime_image: RuntimeImageSnapshot;
  /** Complete, immutable resource contract consumed by Dispatcher. */
  sandbox_limits: EffectiveSandboxLimits;
  /** Added by the Job creation boundary from the canvas target. */
  network_policy?: FrozenNetworkPolicy;
  /** Exact immutable shared-asset versions selected when this Job is created. */
  shared_assets?: SharedAssetSelection[];
  shared_assets_revision?: string;
}

export interface RoleRuntimeSnapshotApplication {
  resolveAgentSnapshotForJob(
    db: RoleRuntimeSnapshotTransaction,
    projectId: string,
    jobType: string,
  ): Promise<RoleRuntimeSnapshotResult>;
}
