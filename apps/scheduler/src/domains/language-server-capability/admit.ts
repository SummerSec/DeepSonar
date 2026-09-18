import {
  LANGUAGE_SERVER_UNAVAILABLE_CODE,
  buildRepairFeedback,
  type FrozenLanguageServerCapability,
  type LanguageServerUnavailableReason,
  type RepairFeedback,
} from "@deepsonar/shared-types";
import {
  findLanguageServerCapability,
  freezeLanguageServerCapability,
} from "./catalog.js";

export type LanguageServerAdmitRequest = {
  capabilityId: string;
  imageKey: string;
  /** True when compile_commands.json (or equivalent) is present in the workspace. */
  hasCompileCommands: boolean;
  /** Agents must never request runtime LSP installation; Scheduler rejects it. */
  installRequested?: boolean;
  operation?: string;
};

export type LanguageServerAdmitResult =
  | { ok: true; frozen: FrozenLanguageServerCapability }
  | {
      ok: false;
      code: typeof LANGUAGE_SERVER_UNAVAILABLE_CODE;
      reason: LanguageServerUnavailableReason;
      repair: RepairFeedback;
    };

function unavailable(
  reason: LanguageServerUnavailableReason,
  input: {
    operation: string;
    path: string;
    message: string;
    expected: unknown;
    observed: unknown;
    next_action: string;
  },
): Extract<LanguageServerAdmitResult, { ok: false }> {
  const category =
    reason === "missing_precondition" || reason === "unregistered"
      ? "model_correctable"
      : "permanent_failure";
  return {
    ok: false,
    code: LANGUAGE_SERVER_UNAVAILABLE_CODE,
    reason,
    repair: buildRepairFeedback({
      category,
      code: LANGUAGE_SERVER_UNAVAILABLE_CODE,
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
 * Scheduler admission for language-server capability modules.
 * Rejects unregistered ids, incompatible images, missing compile_commands.json,
 * and any attempt to install an LSP at runtime. Never falls back to raw clangd shell.
 */
export function admitLanguageServerCapability(request: LanguageServerAdmitRequest): LanguageServerAdmitResult {
  const operation = request.operation ?? "admit_language_server";

  if (request.installRequested) {
    return unavailable("install_forbidden", {
      operation,
      path: "language_server.install",
      message: "Agents must not apt/npm install language servers; only governed catalog modules may be admitted.",
      expected: { install: false, catalog: "language-server.*" },
      observed: { installRequested: true, capabilityId: request.capabilityId },
      next_action: "remove_install_request_and_select_catalog_capability",
    });
  }

  const module = findLanguageServerCapability(request.capabilityId);
  if (!module) {
    return unavailable("unregistered", {
      operation,
      path: "language_server.id",
      message: "Language-server capability is not registered in the governed catalog.",
      expected: { kind: "registered_language_server_capability" },
      observed: { capabilityId: request.capabilityId },
      next_action: "select_registered_language_server_or_continue_without_lsp",
    });
  }

  if (!module.compatible_images.includes(request.imageKey)) {
    return unavailable("incompatible_image", {
      operation,
      path: "language_server.image_key",
      message: "Runtime image is not compatible with the requested language-server capability.",
      expected: { compatible_images: [...module.compatible_images] },
      observed: { imageKey: request.imageKey, capabilityId: module.id },
      next_action: "choose_compatible_audit_image_or_different_capability",
    });
  }

  if (module.requires.includes("compile_commands.json") && !request.hasCompileCommands) {
    return unavailable("missing_precondition", {
      operation,
      path: "language_server.requires.compile_commands.json",
      message: "compile_commands.json is required before admitting clangd; do not invent LSP results.",
      expected: { requires: ["compile_commands.json"] },
      observed: { hasCompileCommands: false, capabilityId: module.id },
      next_action: "generate_or_locate_compile_commands_json_then_retry",
    });
  }

  return {
    ok: true,
    frozen: freezeLanguageServerCapability({ module, imageKey: request.imageKey }),
  };
}
