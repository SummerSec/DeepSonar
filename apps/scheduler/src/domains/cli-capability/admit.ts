import {
  CLI_UNAVAILABLE_CODE,
  buildRepairFeedback,
  type FrozenCliCapability,
  type FrozenCliCapabilityPack,
  type CliUnavailableReason,
  type RepairFeedback,
} from "@deepsonar/shared-types";
import {
  findCliCapability,
  freezeCliCapability,
  freezeCliCapabilityPack,
} from "./catalog.js";

export type CliAdmitRequest = {
  capabilityId: string;
  imageKey: string;
  /** Agents must never request runtime apt/npm/pip installs; Scheduler rejects it. */
  installRequested?: boolean;
  operation?: string;
};

export type CliAdmitResult =
  | { ok: true; frozen: FrozenCliCapability }
  | {
      ok: false;
      code: typeof CLI_UNAVAILABLE_CODE;
      reason: CliUnavailableReason;
      repair: RepairFeedback;
    };

export type CliAdmitSetRequest = {
  ids: readonly string[];
  imageKey: string;
  installRequested?: boolean;
  operation?: string;
};

export type CliAdmitSetResult =
  | { ok: true; frozen: FrozenCliCapability[]; pack: FrozenCliCapabilityPack }
  | {
      ok: false;
      code: typeof CLI_UNAVAILABLE_CODE;
      reason: CliUnavailableReason;
      failed_id?: string;
      repair: RepairFeedback;
    };

function unavailable(
  reason: CliUnavailableReason,
  input: {
    operation: string;
    path: string;
    message: string;
    expected: unknown;
    observed: unknown;
    next_action: string;
  },
): Extract<CliAdmitResult, { ok: false }> {
  const category =
    reason === "unregistered" || reason === "tool_missing" || reason === "inconclusive"
      ? "model_correctable"
      : "permanent_failure";
  return {
    ok: false,
    code: CLI_UNAVAILABLE_CODE,
    reason,
    repair: buildRepairFeedback({
      category,
      code: CLI_UNAVAILABLE_CODE,
      operation: input.operation,
      path: input.path,
      message: input.message,
      expected: input.expected,
      observed_shape: input.observed,
      next_action: input.next_action,
    }),
  };
}

/**
 * Scheduler admission for a single CLI capability module.
 * Rejects install requests, unregistered ids, incompatible images, and
 * capabilities not yet shipped (default_available=false → tool_missing).
 * Never falls back to unregistered shell commands.
 */
export function admitCliCapability(request: CliAdmitRequest): CliAdmitResult {
  const operation = request.operation ?? "admit_cli_capability";

  if (request.installRequested) {
    return unavailable("install_forbidden", {
      operation,
      path: "cli_capability.install",
      message: "Agents must not apt/npm/pip install CLI tools; only governed catalog modules may be admitted.",
      expected: { install: false, catalog: "cli.*" },
      observed: { installRequested: true, capabilityId: request.capabilityId },
      next_action: "remove_install_request_and_select_catalog_capability",
    });
  }

  const module = findCliCapability(request.capabilityId);
  if (!module) {
    return unavailable("unregistered", {
      operation,
      path: "cli_capability.id",
      message: "CLI capability is not registered in the governed catalog.",
      expected: { kind: "registered_cli_capability" },
      observed: { capabilityId: request.capabilityId },
      next_action: "select_registered_cli_capability_via_list_capabilities",
    });
  }

  if (!module.default_available || module.compatible_images.length === 0) {
    return unavailable("tool_missing", {
      operation,
      path: "cli_capability.default_available",
      message: "CLI capability is registered but the tool is not yet pinned/shipped on runtime images.",
      expected: { default_available: true, tool: module.tool },
      observed: {
        capabilityId: module.id,
        default_available: module.default_available,
        compatible_images: [...module.compatible_images],
      },
      next_action: "choose_available_cli_capability_or_continue_without_it",
    });
  }

  if (!module.compatible_images.includes(request.imageKey)) {
    return unavailable("incompatible_image", {
      operation,
      path: "cli_capability.image_key",
      message: "Runtime image is not compatible with the requested CLI capability.",
      expected: { compatible_images: [...module.compatible_images] },
      observed: { imageKey: request.imageKey, capabilityId: module.id },
      next_action: "choose_compatible_image_or_different_capability",
    });
  }

  return {
    ok: true,
    frozen: freezeCliCapability({ module, imageKey: request.imageKey }),
  };
}

/** Admit and freeze a set of CLI capabilities into a Job pack fingerprint. */
export function admitCliCapabilities(request: CliAdmitSetRequest): CliAdmitSetResult {
  const operation = request.operation ?? "admit_cli_capabilities";
  if (request.installRequested) {
    const single = admitCliCapability({
      capabilityId: request.ids[0] ?? "cli.unknown",
      imageKey: request.imageKey,
      installRequested: true,
      operation,
    });
    if (single.ok) {
      return {
        ok: false,
        code: CLI_UNAVAILABLE_CODE,
        reason: "install_forbidden",
        repair: buildRepairFeedback({
          category: "permanent_failure",
          code: CLI_UNAVAILABLE_CODE,
          operation,
          path: "cli_capability.install",
          message: "Agents must not apt/npm/pip install CLI tools.",
          expected: { install: false },
          observed_shape: { installRequested: true },
          next_action: "remove_install_request_and_select_catalog_capability",
        }),
      };
    }
    return { ...single, failed_id: request.ids[0] };
  }

  const frozen: FrozenCliCapability[] = [];
  for (const id of request.ids) {
    const result = admitCliCapability({
      capabilityId: id,
      imageKey: request.imageKey,
      operation,
    });
    if (!result.ok) {
      return { ...result, failed_id: id };
    }
    frozen.push(result.frozen);
  }

  return {
    ok: true,
    frozen,
    pack: freezeCliCapabilityPack({ frozen, imageKey: request.imageKey }),
  };
}
