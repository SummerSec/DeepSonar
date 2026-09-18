import { createHash } from "node:crypto";
import {
  CAPABILITY_PACK_SCHEMA,
  CapabilityPackDraft,
  LANGUAGE_SERVER_CAPABILITY_SCHEMA,
  LanguageServerCapabilityManifest,
  type FrozenLanguageServerCapability,
  type LanguageServerCapabilityManifest as LsManifest,
} from "@deepsonar/shared-types";
import {
  capabilityPackDigest,
  freezeCapabilityPackManifest,
  type CapabilityCatalogRecord,
} from "../capability-pack/catalog.js";

export const LANGUAGE_SERVER_CLANGD_ID = "language-server.clangd" as const;

const CLANGD_COMPATIBLE_IMAGES = [
  "deepsonar-chrome-audit",
  "deepsonar-clickhouse-audit",
] as const;

const CLANGD_OPERATIONS = [
  "definition",
  "references",
  "hover",
  "document_symbol",
  "workspace_symbol",
  "diagnostics",
] as const;

/** Authoritative governed catalog for language-server capability modules (phase 1: clangd). */
export const LANGUAGE_SERVER_CAPABILITY_MANIFESTS: readonly LsManifest[] = [
  LanguageServerCapabilityManifest.parse({
    schema: LANGUAGE_SERVER_CAPABILITY_SCHEMA,
    id: LANGUAGE_SERVER_CLANGD_ID,
    version: "1.0.0",
    languages: ["c", "cpp"],
    server: "clangd",
    server_version: "image-pinned",
    compatible_images: [...CLANGD_COMPATIBLE_IMAGES],
    executable: "clangd",
    operations: [...CLANGD_OPERATIONS],
    requires: ["compile_commands.json"],
    read_only: true,
    network: "disabled",
    limits: {
      max_calls_per_job: 64,
      timeout_ms: 30_000,
      max_response_bytes: 262_144,
      cpu: 1,
      memory_mib: 1024,
    },
    manual_paths: [
      "agent-harness/runtime-manuals/catalog.json#deepsonar-chrome-audit/clangd",
      "agent-harness/runtime-manuals/catalog.json#deepsonar-clickhouse-audit/clangd",
    ],
    summary:
      "Governed read-only clangd for C/C++ audit images; Hub proposes, Scheduler freezes; agents must not apt-install LSPs.",
  }),
];

function packDraftForLanguageServer(module: LsManifest): CapabilityPackDraft {
  return CapabilityPackDraft.parse({
    schema: CAPABILITY_PACK_SCHEMA,
    id: module.id,
    version: module.version,
    scope: "builtin",
    summary: module.summary,
    capabilities: ["read_workspace"],
    inputs: [
      { name: "workspace", schema: "string", required: true },
      { name: "compile_commands_json", schema: "path", required: true },
    ],
    outputs: [{ name: "language_server_result", artifact_schema: "language_server.query_result" }],
    permissions: { platform_tools: [], allow_egress: false },
    budget: { max_attempts: 3, max_tokens: 50_000 },
    failure_policy: { correctable: true, replay: "same_session" },
    evaluator: `capability.${module.id}.v1`,
  });
}

export function languageServerCapabilityPackRecords(): CapabilityCatalogRecord[] {
  return LANGUAGE_SERVER_CAPABILITY_MANIFESTS.map((module) => ({
    manifest: freezeCapabilityPackManifest(packDraftForLanguageServer(module)),
    source_kind: "builtin",
  }));
}

export function findLanguageServerCapability(id: string): LsManifest | undefined {
  return LANGUAGE_SERVER_CAPABILITY_MANIFESTS.find((module) => module.id === id);
}

export function listLanguageServerCapabilities(): LsManifest[] {
  return [...LANGUAGE_SERVER_CAPABILITY_MANIFESTS];
}

export function languageServerConfigFingerprint(input: {
  id: string;
  version: string;
  server: string;
  server_version: string;
  image_key: string;
  operations: readonly string[];
  requires: readonly string[];
  limits?: unknown;
}): string {
  const body = {
    id: input.id,
    version: input.version,
    server: input.server,
    server_version: input.server_version,
    image_key: input.image_key,
    operations: [...input.operations].sort(),
    requires: [...input.requires].sort(),
    limits: input.limits ?? null,
    read_only: true,
    network: "disabled",
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

export function freezeLanguageServerCapability(input: {
  module: LsManifest;
  imageKey: string;
}): FrozenLanguageServerCapability {
  const config_fingerprint = languageServerConfigFingerprint({
    id: input.module.id,
    version: input.module.version,
    server: input.module.server,
    server_version: input.module.server_version,
    image_key: input.imageKey,
    operations: input.module.operations,
    requires: input.module.requires,
    limits: input.module.limits,
  });
  return {
    schema: LANGUAGE_SERVER_CAPABILITY_SCHEMA,
    id: input.module.id,
    version: input.module.version,
    server: input.module.server,
    server_version: input.module.server_version,
    image_key: input.imageKey,
    config_fingerprint,
    operations: [...input.module.operations],
    limits: { ...input.module.limits },
    read_only: true,
    network: "disabled",
  };
}

export function languageServerPackDigest(id: string): string | undefined {
  const module = findLanguageServerCapability(id);
  if (!module) return undefined;
  return capabilityPackDigest(packDraftForLanguageServer(module));
}

/**
 * Resolve a catalog language-server module compatible with `imageKey`.
 * Does not admit or freeze by itself — callers must run `admitLanguageServerCapability`.
 */
export function languageServerForImage(imageKey: string) {
  return LANGUAGE_SERVER_CAPABILITY_MANIFESTS.find((item) => item.compatible_images.includes(imageKey));
}
