import { createHash } from "node:crypto";
import {
  EXTENSION_MATERIALIZATION_PACK_SCHEMA,
  EXTENSION_MATERIALIZATION_SCHEMA,
  MaterializationComponentManifest,
  PI_EXTENSION_REGISTRY,
  type FrozenMaterializationComponent,
  type FrozenMaterializationPack,
  type MaterializationComponentManifest as Manifest,
} from "@deepsonar/shared-types";

function manifest(input: Omit<Manifest, "schema">): Manifest {
  return MaterializationComponentManifest.parse({
    schema: EXTENSION_MATERIALIZATION_SCHEMA,
    ...input,
  });
}

const DEFAULT_LIMITS = { max_materialize_ms: 60_000, max_bytes: 16_777_216 } as const;

/**
 * Phase-1 governed catalog (#615). Seeds from the existing Pi Extension registry
 * so Job freeze/materialize share one component model. Additional skill/tool rows
 * land in follow-up PRs; runtime dynamic install remains forbidden regardless.
 */
export const EXTENSION_MATERIALIZATION_MANIFESTS: readonly Manifest[] = [
  ...Object.values(PI_EXTENSION_REGISTRY).map((ext) =>
    manifest({
      component_id: `pi.extension.${ext.id}`,
      type: "pi_extension",
      source_kind: "image_preinstall",
      source: ext.package,
      version: ext.version,
      digest: ext.integrity,
      compatible_agent_clis: ["pi"],
      compatible_image_keys: [...ext.compatible_image_keys],
      permissions: [...ext.capabilities],
      allow_network: ext.requires_egress,
      dependencies: [],
      entry: ext.entry,
      manuals_path: `docs/EXTENSION_MATERIALIZATION.md#${ext.id}`,
      runtime_limits: { ...DEFAULT_LIMITS },
      security_level: "reviewed",
      maintenance_status: "active",
      summary: `Governed Pi extension ${ext.id} (${ext.package}@${ext.version}); image-preinstalled, Job runtime must not npm/npx install.`,
    }),
  ),
];

export function listMaterializationComponents(): readonly Manifest[] {
  return EXTENSION_MATERIALIZATION_MANIFESTS;
}

export function findMaterializationComponent(componentId: string): Manifest | null {
  return EXTENSION_MATERIALIZATION_MANIFESTS.find((row) => row.component_id === componentId) ?? null;
}

export function findMaterializationComponentByPiExtensionId(extensionId: string): Manifest | null {
  return findMaterializationComponent(`pi.extension.${extensionId}`);
}

export function validateMaterializationManifest(value: unknown): Manifest {
  return MaterializationComponentManifest.parse(value);
}

export function freezeMaterializationComponent(input: {
  module: Manifest;
  imageKey: string;
  agentCli: "claude-code" | "pi" | "dsh";
}): FrozenMaterializationComponent {
  const { module, imageKey, agentCli } = input;
  return {
    schema: EXTENSION_MATERIALIZATION_SCHEMA,
    component_id: module.component_id,
    type: module.type,
    source_kind: module.source_kind,
    source: module.source,
    version: module.version,
    digest: module.digest,
    allow_network: module.allow_network,
    entry: module.entry,
    manuals_path: module.manuals_path,
    image_key: imageKey,
    agent_cli: agentCli,
  };
}

export function materializationPackFingerprint(
  components: readonly FrozenMaterializationComponent[],
  imageKey: string,
  agentCli: string,
): string {
  const canonical = JSON.stringify({
    schema: EXTENSION_MATERIALIZATION_PACK_SCHEMA,
    image_key: imageKey,
    agent_cli: agentCli,
    components: [...components]
      .map((c) => ({
        component_id: c.component_id,
        version: c.version,
        digest: c.digest,
        type: c.type,
        source_kind: c.source_kind,
      }))
      .sort((a, b) => a.component_id.localeCompare(b.component_id)),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function freezeMaterializationPack(input: {
  frozen: readonly FrozenMaterializationComponent[];
  imageKey: string;
  agentCli: "claude-code" | "pi" | "dsh";
}): FrozenMaterializationPack {
  return {
    schema: EXTENSION_MATERIALIZATION_PACK_SCHEMA,
    components: [...input.frozen],
    pack_fingerprint: materializationPackFingerprint(input.frozen, input.imageKey, input.agentCli),
    image_key: input.imageKey,
    agent_cli: input.agentCli,
  };
}
