import type { sql } from "./db.js";
import type { CreateJobInput } from "./core.js";
import type { AgentRuntimeSnapshot } from "./domains/role-runtime-snapshot/index.js";
import { freezeRuntimeKnobs, mergeRoleRuntimeKnobOverrides, resolveRuntimeKnobs } from "./runtime-knobs.js";
import { buildAgentRuntimeLaunchSpecification } from "@deepsonar/runtime-sandbox";
import { freezeAgentRuntimeProfile } from "./agent-runtime-profile.js";
import { assertObservationalMemoryQuota, freezeObservationalMemoryQuotas,
  observationalMemoryConfig, parseFrozenPiExtensions } from "./pi-extensions.js";

/** Shared read-only freeze for creation and explicit rerun. Fresh extensions are
 * admitted before this step; only platform settings supply OM quota allocations. */
export async function freezeJobRuntimeConfiguration(tx: typeof sql,
  input: Pick<CreateJobInput, "projectId" | "type" | "timeoutSec" | "stallSec" | "maxRequests">,
  snapshot: AgentRuntimeSnapshot) {
  const [projectRow, globalRow] = await Promise.all([
    tx`SELECT config_json FROM projects WHERE id = ${input.projectId}`,
    tx`SELECT rules_json FROM global_settings WHERE id = 'global'`,
  ]);
  const projectRules = (((projectRow[0]?.config_json as Record<string, unknown> | undefined)?.rules ?? {}) ?? {}) as Record<string, unknown>;
  const platformRules = (globalRow[0]?.rules_json ?? {}) as Record<string, unknown>;
  const knobs = resolveRuntimeKnobs({
    jobType: input.type, imageKey: snapshot.runtime_image?.image_key ?? snapshot.runtime_image_key,
    job: { timeoutSec: input.timeoutSec, stallSec: input.stallSec, jobTokenMaxRequests: input.maxRequests },
    role: mergeRoleRuntimeKnobOverrides(snapshot.role_runtime_knobs?.global, snapshot.role_runtime_knobs?.project),
    project: projectRules, platform: platformRules,
  });
  const quotaFrozenPiExtensions = freezeObservationalMemoryQuotas(
    parseFrozenPiExtensions(snapshot.pi_extensions),
    knobs.jobTokenMaxRequests,
  );
  assertObservationalMemoryQuota(quotaFrozenPiExtensions, knobs.jobTokenMaxRequests);
  const quotaObservationalMemory = observationalMemoryConfig(quotaFrozenPiExtensions);
  let runtimeProfile = snapshot.runtime_profile;
  let agentRuntimeLaunch = snapshot.agent_runtime_launch;
  if (quotaObservationalMemory) {
    const { profile_fingerprint: _profileFingerprint, ...profileBody } = snapshot.runtime_profile;
    const piOptions = profileBody.native_options.pi;
    if (!piOptions) throw new Error("PI_OM_RUNTIME_PROFILE_MISSING");
    runtimeProfile = freezeAgentRuntimeProfile({
      ...profileBody,
      native_options: {
        ...profileBody.native_options,
        pi: { ...piOptions, observational_memory: quotaObservationalMemory },
      },
    });
    agentRuntimeLaunch = buildAgentRuntimeLaunchSpecification(
      runtimeProfile,
      snapshot.runtime_image?.image_key ?? snapshot.runtime_image_key ?? "",
    );
  }
  const { role_runtime_knobs: _roleKnobs, ...base } = snapshot;
  const snapshotWithKnobs = {
    ...base,
    pi_extensions: quotaFrozenPiExtensions,
    runtime_profile: runtimeProfile,
    agent_runtime_launch: agentRuntimeLaunch,
    runtime_knobs: freezeRuntimeKnobs(knobs),
  };
  return { snapshotWithKnobs, knobs };
}
