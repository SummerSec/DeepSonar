import {
  TargetAuthorizationRequest,
  TargetAuthorizationSnapshot,
  TargetAuthorizationResponse,
  createTargetAuthorizationConfig,
  makeTargetAuthorizationSnapshot,
  parseReferenceTarget,
  readTargetAuthorizationConfig,
  snapshotMatchesRequest,
  targetBinding,
  targetBindingFromDigest,
  type TargetAuthorizationConfig,
  type TargetAuthorizationSnapshot as FrozenTargetAuthorization,
} from "./contract.js";
import { postTargetAuthorization, type TargetAuthorizationFetch } from "./client.js";
import type { TaskContract, TaskContractFeedback } from "@deepsonar/shared-types";
import { taskContractDigest } from "../../task-outcome-snapshot.js";

export interface TargetAuthorizationCheckInput {
  projectId: string;
  contract: TaskContract;
  principalId?: string | null;
  content?: string;
  frozenSnapshot?: unknown;
  /** Dispatch/rerun must already have a Scheduler-frozen snapshot. */
  requireFrozenSnapshot?: boolean;
  config?: TargetAuthorizationConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: TargetAuthorizationFetch;
  now?: () => Date;
}

export type TargetAuthorizationCheck =
  | { kind: "not_required" }
  | { kind: "allow"; snapshot?: FrozenTargetAuthorization }
  | { kind: "block"; feedback: TaskContractFeedback };

/** A contract can carry a target identity for read-only verification. */
export function targetAuthorizationWriteRequested(contract: TaskContract): boolean {
  return contract.required_actions.includes("write")
    || contract.allowed_actions.includes("write");
}

/** Target authorization is required for target writes or an explicit identity claim. */
export function targetAuthorizationRequired(contract: TaskContract): boolean {
  return targetAuthorizationWriteRequested(contract)
    || contract.identity !== undefined;
}

export function targetAuthorizationSnapshot(value: unknown): FrozenTargetAuthorization | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = TargetAuthorizationSnapshot.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function checkTargetAuthorization(
  input: TargetAuthorizationCheckInput,
): Promise<TargetAuthorizationCheck> {
  if (!targetAuthorizationRequired(input.contract)) return { kind: "not_required" };

  if (input.requireFrozenSnapshot && input.frozenSnapshot === undefined) {
    return blocked(
      "target_authorization_snapshot_missing",
      "The Job has no creation-time target authorization snapshot.",
      "Keep the historical Job unchanged and recreate it through the current authority check.",
      "task_contract",
    );
  }

  const configResult = resolveConfig(input);
  if (configResult.kind === "block") return configResult;
  const config = configResult.config;
  const frozen = targetAuthorizationSnapshot(input.frozenSnapshot);
  if (input.frozenSnapshot !== undefined && !frozen) {
    return blocked(
      "target_authorization_snapshot_invalid",
      "The frozen target authorization snapshot is invalid.",
      "Recreate the task with the current contract and platform configuration.",
      "task_contract",
    );
  }

  const target = parseReferenceTarget(input.contract.targets);
  if (!target) {
    return blocked(
      "target_authorization_target_unsupported",
      "Only one reference-http/v1 target is supported.",
      "Use one target in reference-http/v1:<tenant>/<resource> form.",
      "task_contract.targets",
    );
  }

  const identity = input.contract.identity;
  if (!identity?.tenant || !identity.role || !identity.resource) {
    return blocked(
      "target_authorization_identity_missing",
      "Target authorization requires tenant, role, and resource identity.",
      "Declare the authority-verifiable target identity in the task contract.",
      "task_contract.identity",
    );
  }
  if (target.tenant !== identity.tenant || target.resource !== identity.resource) {
    return blocked(
      "target_authorization_scope_mismatch",
      "The target tenant or resource does not match the declared identity.",
      "Keep the target descriptor and identity fields exactly aligned.",
      "task_contract.targets",
    );
  }

  const principalId = input.principalId?.trim();
  if (!principalId) {
    return blocked(
      "target_authorization_principal_unavailable",
      "No authenticated Scheduler principal is available.",
      "Use an authenticated platform principal; do not infer it from task content.",
      "task_contract.identity",
    );
  }
  if (frozen && principalId !== frozen.principal_id) {
    return blocked(
      "target_authorization_scope_mismatch",
      "The current Scheduler principal does not match the frozen target grant.",
      "Recreate or rerun the Job with the authenticated Scheduler principal.",
      "task_contract.identity",
    );
  }

  if (typeof input.content !== "string" && !frozen) {
    return blocked(
      "target_authorization_content_missing",
      "Creation-time target content is missing.",
      "Keep the Scheduler-owned original content for the initial authorization check.",
      "task_contract",
    );
  }

  const requiredPrerequisites = input.contract.prerequisites
    .filter((item) => item.required)
    .map((item) => ({ id: item.id, state: item.state }));
  if (requiredPrerequisites.some((item) => item.state !== "declared")) {
    return blocked(
      "target_authorization_prerequisite_blocked",
      "A required prerequisite is not declared for authority verification.",
      "Declare each required prerequisite and let the authority return satisfied.",
      "task_contract.prerequisites",
    );
  }

  const binding = typeof input.content === "string"
    ? targetBinding(input.content, input.contract)
    : targetBindingFromDigest(frozen!.content_sha256, taskContractDigest(input.contract));
  if (frozen && (
    frozen.project_id !== input.projectId
    || frozen.target_id !== target.targetId
    || frozen.tenant !== identity.tenant
    || frozen.role !== identity.role
    || frozen.resource !== identity.resource
    || frozen.config_identity !== config.configIdentity
    || frozen.content_sha256 !== binding.content_sha256
    || frozen.task_contract_sha256 !== binding.task_contract_sha256
    || frozen.revision !== binding.revision
  )) {
    return blocked(
      "target_authorization_snapshot_binding_changed",
      "The frozen target grant does not match the current project, target, contract, content, or platform configuration.",
      "Keep the historical Job unchanged and create a new Job with an explicit current authority decision.",
      "task_contract",
    );
  }

  const now = input.now ?? (() => new Date());
  const request: TargetAuthorizationRequest = {
    protocol: "deepsonar.target-authorization/v1",
    authority_id: config.authorityId,
    config_identity: config.configIdentity,
    project_id: input.projectId,
    target: { adapter: target.adapter, target_id: target.targetId },
    principal: { id: principalId },
    identity: { tenant: identity.tenant, role: identity.role, resource: identity.resource },
    requested_actions: [...config.requestedActions],
    prerequisites: requiredPrerequisites.map((item) => ({ id: item.id, state: "declared" as const })),
    binding,
    freshness: { requested_at: now().toISOString(), max_age_seconds: config.maxAgeSeconds },
    ...(frozen ? { expected_authority_revision: frozen.authority_revision } : {}),
  };
  const parsedRequest = TargetAuthorizationRequest.safeParse(request);
  if (!parsedRequest.success) {
    return blocked(
      "target_authorization_request_invalid",
      "The Scheduler-generated target authorization request is invalid.",
      "Fix the platform configuration or task contract before dispatch.",
      "task_contract",
    );
  }

  const transport = await postTargetAuthorization(config, parsedRequest.data, {
    env: input.env,
    fetchImpl: input.fetchImpl,
    timeoutMs: config.timeoutMs,
  });
  if (transport.kind === "error") return transportFeedback(transport.code);

  const checked = validateAuthorizationResponse(parsedRequest.data, transport.response, now());
  if (checked.kind === "block") return checked;
  const snapshot = makeTargetAuthorizationSnapshot(parsedRequest.data, transport.response);
  if (frozen && !snapshotMatchesRequest(frozen, parsedRequest.data)) {
    return blocked(
      "target_authorization_snapshot_binding_changed",
      "The authority response does not match the frozen target grant.",
      "Keep the historical Job and create a new one with a current explicit grant.",
      "task_contract",
    );
  }
  return { kind: "allow", snapshot };
}

function resolveConfig(input: TargetAuthorizationCheckInput):
  | { kind: "allow"; config: TargetAuthorizationConfig }
  | { kind: "block"; feedback: TaskContractFeedback } {
  if (input.config) return { kind: "allow", config: input.config };
  try {
    const config = readTargetAuthorizationConfig(input.env ?? process.env);
    if (!config) {
      return {
        kind: "block",
        feedback: makeFeedback(
          "target_authorization_unconfigured",
          "The platform has no target authorization authority configured.",
          "Configure the governed authority URL, secret reference, and reference adapter.",
          "task_contract",
        ),
      };
    }
    return { kind: "allow", config };
  } catch {
    return {
      kind: "block",
      feedback: makeFeedback(
        "target_authorization_configuration_invalid",
        "The platform target authorization configuration is invalid.",
        "Repair the platform configuration and retry the current task contract.",
        "task_contract",
      ),
    };
  }
}

function validateAuthorizationResponse(
  request: TargetAuthorizationRequest,
  response: TargetAuthorizationResponse,
  now: Date,
): TargetAuthorizationCheck {
  if (response.authority_id !== request.authority_id || response.config_identity !== request.config_identity) {
    return blocked(
      "target_authorization_authority_changed",
      "The authority identity does not match platform configuration.",
      "Use the configured authority only; do not switch authority silently.",
      "task_contract",
    );
  }
  if (response.decision === "deny") return deniedFeedback(response.reason_code);
  if (request.expected_authority_revision && response.authority_revision !== request.expected_authority_revision) {
    return blocked(
      "target_authorization_policy_changed",
      "The authority policy revision changed for the frozen grant.",
      "Obtain a new explicit authority decision before dispatch.",
      "task_contract",
    );
  }
  const expectedScope = {
    project_id: request.project_id,
    target: request.target,
    principal_id: request.principal.id,
    tenant: request.identity.tenant,
    role: request.identity.role,
    resource: request.identity.resource,
  };
  if (!scopeMatches(response.scope, expectedScope)) {
    return blocked(
      "target_authorization_scope_mismatch",
      "The authority scope does not match the project, target, principal, or identity.",
      "Repair the authority binding; Scheduler will not widen or substitute the scope.",
      "task_contract.identity",
    );
  }
  if (!bindingMatches(response.binding, request.binding)) {
    return blocked(
      "target_authorization_binding_mismatch",
      "The authority content or revision binding does not match the request.",
      "Authorize the exact current task content and contract revision.",
      "task_contract",
    );
  }
  const requested = [...request.requested_actions];
  const returned = response.actions.map((item) => item.action);
  if (new Set(returned).size !== returned.length
    || JSON.stringify(returned) !== JSON.stringify(requested)
    || response.actions.some((item) => item.effect !== "allow")) {
    return blocked(
      "target_authorization_action_denied",
      "The authority did not allow every exact requested action in order.",
      "Use only the exact save, publish, and trigger actions returned by the authority.",
      "task_contract.required_actions",
    );
  }
  const requiredPrerequisites = request.prerequisites.map((item) => item.id).sort();
  const returnedPrerequisites = response.prerequisites.map((item) => item.id).sort();
  if (new Set(returnedPrerequisites).size !== returnedPrerequisites.length
    || JSON.stringify(returnedPrerequisites) !== JSON.stringify(requiredPrerequisites)
    || response.prerequisites.some((item) => item.status !== "satisfied")) {
    return blocked(
      "target_authorization_prerequisite_blocked",
      "The authority did not confirm every required prerequisite.",
      "Resolve prerequisites and obtain a new authority decision before dispatch.",
      "task_contract.prerequisites",
    );
  }
  const expiresAt = Date.parse(response.expires_at);
  const nowMs = now.getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return blocked(
      "target_authorization_expired",
      "The authority grant is expired.",
      "Obtain a fresh grant bound to the current content and revision.",
      "task_contract",
    );
  }
  if (expiresAt > nowMs + request.freshness.max_age_seconds * 1000) {
    return blocked(
      "target_authorization_freshness_invalid",
      "The authority grant exceeds the platform freshness limit.",
      "Return a short-lived authority decision within the configured freshness bound.",
      "task_contract",
    );
  }
  return { kind: "allow" };
}

function scopeMatches(
  actual: TargetAuthorizationResponse["scope"],
  expected: TargetAuthorizationResponse["scope"],
): boolean {
  return actual.project_id === expected.project_id
    && actual.target.adapter === expected.target.adapter
    && actual.target.target_id === expected.target.target_id
    && actual.principal_id === expected.principal_id
    && actual.tenant === expected.tenant
    && actual.role === expected.role
    && actual.resource === expected.resource;
}

function bindingMatches(
  actual: TargetAuthorizationResponse["binding"],
  expected: TargetAuthorizationResponse["binding"],
): boolean {
  return actual.content_sha256 === expected.content_sha256
    && actual.task_contract_sha256 === expected.task_contract_sha256
    && actual.revision === expected.revision;
}

function deniedFeedback(reason: TargetAuthorizationResponse["reason_code"]): TargetAuthorizationCheck {
  switch (reason) {
    case "scope_mismatch":
      return blocked("target_authorization_scope_mismatch", "The authority rejected the requested scope.", "Verify project, principal, tenant, role, and resource.", "task_contract.identity");
    case "prerequisite_unavailable":
      return blocked("target_authorization_prerequisite_blocked", "The authority rejected an unavailable prerequisite.", "Resolve the prerequisite and request a new grant.", "task_contract.prerequisites");
    case "revoked":
      return blocked("target_authorization_revoked", "The authority revoked the target grant.", "Stop target writes and obtain a new explicit grant.", "task_contract");
    case "expired":
      return blocked("target_authorization_expired", "The authority grant is expired.", "Obtain a fresh grant bound to the current revision.", "task_contract");
    case "policy_changed":
      return blocked("target_authorization_policy_changed", "The authority policy changed.", "Obtain a new explicit authority decision.", "task_contract");
    default:
      return blocked("target_authorization_denied", "The authority denied the target authorization request.", "Verify the exact identity and action scope.", "task_contract");
  }
}

function transportFeedback(code: string): TargetAuthorizationCheck {
  const feedbackCode = code === "target_authorization_timeout"
    || code === "target_authorization_response_too_large"
    || code === "target_authorization_malformed"
    || code === "target_authorization_secret_unavailable"
    || code === "target_authorization_redirect_rejected"
    ? code
    : "target_authorization_unavailable";
  const messages: Record<string, [string, string]> = {
    target_authorization_secret_unavailable: ["The platform authority secret is unavailable.", "Repair secret injection without placing the secret in task or Job data."],
    target_authorization_timeout: ["The target authorization authority timed out.", "Keep target writes unstarted and retry after authority recovery."],
    target_authorization_unavailable: ["The target authorization authority is unavailable.", "Keep target writes unstarted and retry after authority recovery."],
    target_authorization_redirect_rejected: ["The target authorization authority attempted a redirect.", "Use the fixed platform endpoint and reject redirects."],
    target_authorization_response_too_large: ["The target authorization response exceeded the platform limit.", "Return the bounded versioned response without increasing task-side limits."],
    target_authorization_malformed: ["The target authorization response is malformed.", "Return the strict versioned authority response."],
  };
  const [message, suggestion] = messages[feedbackCode] ?? messages.target_authorization_unavailable;
  return blocked(feedbackCode, message, suggestion, "task_contract");
}

function blocked(code: string, message: string, suggestion: string, path: string): TargetAuthorizationCheck {
  return { kind: "block", feedback: makeFeedback(code, message, suggestion, path) };
}

function makeFeedback(code: string, message: string, suggestion: string, path: string): TaskContractFeedback {
  return { code, path, message, suggestion };
}

/** Validate a stored snapshot without exposing its URL or secret reference. */
export function assertTargetAuthorizationSnapshot(value: unknown): FrozenTargetAuthorization {
  return TargetAuthorizationSnapshot.parse(value);
}

/** Explicit helper for tests and platform bootstrap code. */
export function referenceTargetConfig(input: Parameters<typeof createTargetAuthorizationConfig>[0]): TargetAuthorizationConfig {
  return createTargetAuthorizationConfig(input);
}
