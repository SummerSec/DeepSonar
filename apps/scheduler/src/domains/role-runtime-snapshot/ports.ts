import type { RuntimeImageSnapshot } from "../../runtime-images.js";
import type { MissingModule } from "../../skill-sources.js";
import type { FrozenCapabilityPack } from "../capability-pack/catalog.js";
import type { FrozenAgentRuntimeProfile,
  FrozenLanguageServerCapability,
  FrozenCliCapability,
  FrozenCliCapabilityPack,
  FrozenMaterializationPack,
  FrozenProviderModelSnapshot } from "@deepsonar/shared-types";
import type { PlatformToolName, ReasoningValue, RuntimeProfileOverridePayload } from "@deepsonar/shared-types";
import type { SharedAssetSelection } from "../shared-assets/application.js";
import type { AgentCliRuntimeSnapshot, AgentRuntimeLaunchSpecification } from "@deepsonar/runtime-sandbox";
import type { EffectiveSandboxLimits, FrozenNetworkPolicy } from "./sandbox-limits.js";
import type { FrozenRuntimeKnobs, RuntimeKnobOverride } from "../../runtime-knobs.js";

/** Minimal transaction-shaped client accepted by the snapshot application. */
export type RoleRuntimeSnapshotTransaction = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
  json?: (value: unknown) => unknown;
};

export interface RoleRuntimeSnapshotResult {
  name: string;
  role_kind: "role" | "hub" | "system";
  ui_color: string | null;
  agent_cli: string;
  /** DSH tool presentation preset frozen for this Job; ignored by other CLIs. */
  dsh_task_mode: "standard" | "ptc";
  /** Immutable adapter implementation/capability contract captured at Job creation. */
  agent_runtime: AgentCliRuntimeSnapshot;
  /** Unified provider/CLI/profile projection frozen with this Job (#613). */
  runtime_profile: FrozenAgentRuntimeProfile;
  /** Adapter-owned launch contract derived from the frozen Runtime Profile (#617). */
  agent_runtime_launch: AgentRuntimeLaunchSpecification;
  model: string | null;
  /** Actual upstream model ID after resolving CLI aliases such as fable. */
  upstream_model: string | null;
  /** Frozen Pi models.json route for `--provider`. Null for non-Pi CLIs. */
  pi_provider: string | null;
  reasoning: ReasoningValue | null;
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
  /** Frozen Capability Pack envelope for this Job; selectors/digest do not follow later source sync. */
  capability_pack?: FrozenCapabilityPack;
  /** Frozen language-server capability selected for this Job (#604); absent when Hub did not admit one. */
  language_server?: FrozenLanguageServerCapability;
  /** Frozen CLI capabilities selected for this Job (#611); absent when Hub did not propose any. */
  cli_capabilities?: FrozenCliCapability[];
  /** Pack fingerprint over the selected CLI capability set (#611). */
  cli_capability_pack?: FrozenCliCapabilityPack;
  /** Frozen Extension/Tool materialization pack (#615); components + digests at Job create. */
  component_materialization_pack?: FrozenMaterializationPack;
  /** Frozen Provider Adapter + Model Descriptor snapshot (#614). */
  provider_model?: FrozenProviderModelSnapshot;
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
  /** Registered Pi extensions frozen at Job create; empty for non-Pi CLIs. */
  pi_extensions: {
    id: string;
    package: string;
    version: string;
    integrity: string;
    entry_path: string;
    workspace_path: string;
    requires_egress: boolean;
    compatible_image_keys: string[];
  }[];
  role_config_id: string | null;
  role_config_version: number | null;
  runtime_image_key: string | null;
  runtime_image: RuntimeImageSnapshot;
  /** Complete, immutable resource contract consumed by Dispatcher. */
  sandbox_limits: EffectiveSandboxLimits;
  /** Project RoleConfig overlay on global RoleConfig; consumed at Job create then dropped. */
  role_runtime_knobs?: { global?: RuntimeKnobOverride; project?: RuntimeKnobOverride };
  /** Frozen batch-1 runtime knobs. Next Job reads current DB; running Job keeps this snapshot. */
  runtime_knobs?: FrozenRuntimeKnobs;
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
    options?: {
      runtimeImageKey?: string | null;
      /** Hub 提案的 agent_cli；省略时走项目软缺省 / RoleConfig。 */
      agentCli?: string | null;
      /** Hub 提案的 credential_id；省略时走项目软缺省 / RoleConfig 绑定。 */
      credentialId?: string | null;
      /** Hub/Task model proposal; resolved against the selected Provider catalog. */
      modelRef?: string | null;
      /** Hub task-level business-instruction override; frozen into this Job only. */
      taskPromptOverride?: string | null;
      /** Capability requirements rechecked before the Job snapshot is frozen. */
      modelRequirements?: Record<string, unknown> | null;
      runtimeProfile?: RuntimeProfileOverridePayload | null;
      /** Hub 提案的 language-server capability id（#604）；省略则不冻结。 */
      languageServerCapabilityId?: string | null;
      /** Hub 提案的通用 CLI 能力 id 列表（#611）；省略则不冻结。 */
      cliCapabilityIds?: readonly string[] | null;
    },
  ): Promise<RoleRuntimeSnapshotResult>;
}
