import {
  COMPONENT_MATERIALIZATION_FAILED,
  buildRepairFeedback,
  isForbiddenRuntimeInstallCommand,
  type ComponentMaterializationFailureReason,
  type FrozenMaterializationComponent,
  type FrozenMaterializationPack,
  type RepairFeedback,
} from "@deepsonar/shared-types";
import {
  findMaterializationComponent,
  findMaterializationComponentByPiExtensionId,
  freezeMaterializationComponent,
  freezeMaterializationPack,
} from "./catalog.js";

export type MaterializeAdmitRequest = {
  componentId: string;
  imageKey: string;
  agentCli: "claude-code" | "pi" | "dsh";
  /** Agents must never request runtime npm/npx/pip/remote installs. */
  installRequested?: boolean;
  installCommand?: string;
  operation?: string;
};

export type MaterializeAdmitResult =
  | { ok: true; frozen: FrozenMaterializationComponent }
  | {
      ok: false;
      code: typeof COMPONENT_MATERIALIZATION_FAILED;
      reason: ComponentMaterializationFailureReason;
      repair: RepairFeedback;
    };

export type MaterializePackAdmitRequest = {
  /** Registered component_ids and/or legacy Pi extension ids (pi-web-access). */
  componentIds?: readonly string[];
  piExtensionIds?: readonly string[];
  imageKey: string;
  agentCli: "claude-code" | "pi" | "dsh";
  /** Snapshot skills that still carry a `repo` field (legacy dynamic install). */
  repoSkills?: readonly { name: string; repo?: string }[];
  installRequested?: boolean;
  installCommand?: string;
  operation?: string;
};

export type MaterializePackAdmitResult =
  | { ok: true; frozen: FrozenMaterializationComponent[]; pack: FrozenMaterializationPack }
  | {
      ok: false;
      code: typeof COMPONENT_MATERIALIZATION_FAILED;
      reason: ComponentMaterializationFailureReason;
      failed_id?: string;
      repair: RepairFeedback;
    };

function failed(
  reason: ComponentMaterializationFailureReason,
  input: {
    operation: string;
    path: string;
    message: string;
    expected: unknown;
    observed: unknown;
    next_action: string;
  },
): Extract<MaterializeAdmitResult, { ok: false }> {
  const category =
    reason === "unregistered" || reason === "validation_failed"
      ? "model_correctable"
      : "permanent_failure";
  return {
    ok: false,
    code: COMPONENT_MATERIALIZATION_FAILED,
    reason,
    repair: buildRepairFeedback({
      category,
      code: COMPONENT_MATERIALIZATION_FAILED,
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
 * Reject Job-runtime dynamic installs (npx/npm/pip/remote) by default (#615).
 * Returns a stable `component_materialization_failed` envelope — never silent skip.
 */
export function rejectRuntimeComponentInstall(input: {
  command?: string;
  installRequested?: boolean;
  operation?: string;
  componentId?: string;
}): Extract<MaterializeAdmitResult, { ok: false }> | null {
  const operation = input.operation ?? "materialize_component";
  const command = input.command?.trim() ?? "";
  if (input.installRequested || (command && isForbiddenRuntimeInstallCommand(command))) {
    return failed("runtime_install_forbidden", {
      operation,
      path: "component.install",
      message:
        "Job runtime must not execute npm/npx/pip/remote installs for extensions or tools; only registry-declared, pre-materialized components are allowed.",
      expected: { install: false, catalog: "extension-materialization" },
      observed: {
        installRequested: Boolean(input.installRequested),
        command: command || null,
        componentId: input.componentId ?? null,
      },
      next_action: "select_registry_component_and_rebuild_image_or_embed_skill",
    });
  }
  return null;
}

/**
 * Admit a single registry component for Job freeze / Scheduler materialization.
 */
export function admitMaterializationComponent(request: MaterializeAdmitRequest): MaterializeAdmitResult {
  const operation = request.operation ?? "admit_materialization_component";

  const installReject = rejectRuntimeComponentInstall({
    installRequested: request.installRequested,
    command: request.installCommand,
    operation,
    componentId: request.componentId,
  });
  if (installReject) return installReject;

  const module =
    findMaterializationComponent(request.componentId)
    ?? findMaterializationComponentByPiExtensionId(request.componentId);
  if (!module) {
    return failed("unregistered", {
      operation,
      path: "component.component_id",
      message: "Extension/tool component is not registered in the governed materialization registry.",
      expected: { kind: "registered_component" },
      observed: { componentId: request.componentId },
      next_action: "select_registered_component_from_extension_materialization_registry",
    });
  }

  if (module.maintenance_status === "retired") {
    return failed("deprecated", {
      operation,
      path: "component.maintenance_status",
      message: "Component is retired and cannot be materialized.",
      expected: { maintenance_status: "active" },
      observed: { component_id: module.component_id, maintenance_status: module.maintenance_status },
      next_action: "choose_active_registry_component",
    });
  }

  if (
    module.compatible_agent_clis.length > 0
    && !module.compatible_agent_clis.includes(request.agentCli)
  ) {
    return failed("incompatible_cli", {
      operation,
      path: "component.compatible_agent_clis",
      message: "Agent CLI is not compatible with the requested component.",
      expected: { compatible_agent_clis: [...module.compatible_agent_clis] },
      observed: { agentCli: request.agentCli, component_id: module.component_id },
      next_action: "choose_compatible_cli_or_different_component",
    });
  }

  if (
    module.compatible_image_keys.length > 0
    && !module.compatible_image_keys.includes(request.imageKey)
  ) {
    return failed("incompatible_image", {
      operation,
      path: "component.compatible_image_keys",
      message: "Runtime image is not compatible with the requested component.",
      expected: { compatible_image_keys: [...module.compatible_image_keys] },
      observed: { imageKey: request.imageKey, component_id: module.component_id },
      next_action: "choose_compatible_image_or_different_component",
    });
  }

  return {
    ok: true,
    frozen: freezeMaterializationComponent({
      module,
      imageKey: request.imageKey,
      agentCli: request.agentCli,
    }),
  };
}

/**
 * Freeze the Job component list from selected registry IDs + Pi extensions.
 * Repo-only skills (legacy `npx skills add` path) fail closed at Job create.
 */
export function freezeMaterializationPackAtJobCreate(
  request: MaterializePackAdmitRequest,
): MaterializePackAdmitResult {
  const operation = request.operation ?? "freeze_materialization_pack";

  const installReject = rejectRuntimeComponentInstall({
    installRequested: request.installRequested,
    command: request.installCommand,
    operation,
  });
  if (installReject) {
    return { ...installReject, failed_id: request.componentIds?.[0] };
  }

  for (const skill of request.repoSkills ?? []) {
    if (skill.repo) {
      return {
        ...failed("runtime_install_forbidden", {
          operation,
          path: "skills.repo",
          message: `Skill ${skill.name} declares a repository install source; Job create refuses dynamic materialization. Register an embedded/image-preinstall component instead.`,
          expected: { source_kind: ["embedded", "image_preinstall", "registry_blob"] },
          observed: { name: skill.name, repo: skill.repo },
          next_action: "convert_repo_skill_to_embedded_or_registry_component",
        }),
        failed_id: skill.name,
      };
    }
  }

  const ids = new Set<string>();
  for (const id of request.componentIds ?? []) {
    const trimmed = String(id).trim();
    if (trimmed) ids.add(trimmed);
  }
  for (const id of request.piExtensionIds ?? []) {
    const trimmed = String(id).trim();
    if (trimmed) ids.add(trimmed.startsWith("pi.extension.") ? trimmed : `pi.extension.${trimmed}`);
  }

  const frozen: FrozenMaterializationComponent[] = [];
  for (const id of ids) {
    const result = admitMaterializationComponent({
      componentId: id,
      imageKey: request.imageKey,
      agentCli: request.agentCli,
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
    pack: freezeMaterializationPack({
      frozen,
      imageKey: request.imageKey,
      agentCli: request.agentCli,
    }),
  };
}

/**
 * Materialization path: only registry-declared (frozen) components may be injected.
 * Unknown or install-seeking requests fail with `component_materialization_failed`.
 */
export function materializeDeclaredComponents(input: {
  frozenPack: FrozenMaterializationPack | null | undefined;
  requestedIds: readonly string[];
  installCommand?: string;
}): MaterializePackAdmitResult {
  const operation = "materialize_declared_components";
  const installReject = rejectRuntimeComponentInstall({
    command: input.installCommand,
    installRequested: Boolean(input.installCommand),
    operation,
  });
  if (installReject) {
    return { ...installReject, failed_id: input.requestedIds[0] };
  }

  const pack = input.frozenPack;
  if (!pack) {
    if (input.requestedIds.length === 0) {
      return {
        ok: true,
        frozen: [],
        pack: freezeMaterializationPack({
          frozen: [],
          imageKey: "none",
          agentCli: "claude-code",
        }),
      };
    }
    return {
      ...failed("unregistered", {
        operation,
        path: "component_materialization_pack",
        message: "Job snapshot has no frozen materialization pack; cannot materialize components.",
        expected: { frozen_pack: true },
        observed: { requestedIds: [...input.requestedIds] },
        next_action: "recreate_job_with_frozen_materialization_pack",
      }),
      failed_id: input.requestedIds[0],
    };
  }

  const byId = new Map(pack.components.map((c) => [c.component_id, c]));
  const selected: FrozenMaterializationComponent[] = [];
  for (const id of input.requestedIds) {
    const normalized = id.startsWith("pi.extension.") ? id : (
      byId.has(id) ? id : `pi.extension.${id}`
    );
    const row = byId.get(id) ?? byId.get(normalized);
    if (!row) {
      return {
        ...failed("unregistered", {
          operation,
          path: "component.component_id",
          message: "Requested component is not in the Job-frozen materialization pack.",
          expected: { component_ids: pack.components.map((c) => c.component_id) },
          observed: { componentId: id },
          next_action: "request_only_frozen_pack_components",
        }),
        failed_id: id,
      };
    }
    selected.push(row);
  }

  return {
    ok: true,
    frozen: selected,
    pack,
  };
}
