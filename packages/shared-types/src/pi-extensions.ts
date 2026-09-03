import { z } from "zod";

/** Image-fixed install root. Job stubs re-export from this prefix only. */
export const PI_EXTENSION_IMAGE_ROOT = "/opt/deepsonar/pi-extensions/node_modules";
export const PI_EXTENSION_WORKSPACE_DIR = ".pi/agent/extensions";
export const PI_EXTENSION_SANDBOX_PREFIX = `/workspace/.deepsonar-home/${PI_EXTENSION_WORKSPACE_DIR}/`;
export const PI_EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const PI_EXTENSION_MAX_PER_ROLE = 8;

export const PiExtensionId = z.string().regex(PI_EXTENSION_ID_PATTERN);
export type PiExtensionId = z.infer<typeof PiExtensionId>;

export interface PiExtensionRegistration {
  id: PiExtensionId;
  package: string;
  version: string;
  integrity: string;
  license: string;
  capabilities: readonly string[];
  requires_egress: boolean;
  compatible_image_keys: readonly string[];
  entry: string;
}

/**
 * Platform allowlist. New extensions = registry row + image preinstall.
 * RoleConfig may only name these IDs; start path stays `--no-extensions` + `-e`.
 */
export const PI_EXTENSION_REGISTRY = {
  "pi-web-access": {
    id: "pi-web-access",
    package: "pi-web-access",
    version: "0.27.0",
    integrity: "sha512-D/z7ILwbnJeDjzFPC1j3G1OvO+j2vl2H13ByYcH5FLbrJ1yBdbBwTBcl96Bbt2NEqH5vdmoZ/EpbDG8BTF9W7Q==",
    license: "MIT",
    capabilities: ["web-search", "content-extract", "url-fetch"],
    requires_egress: true,
    compatible_image_keys: ["deepsonar-audit", "deepsonar-kali-minimal"],
    entry: "index.ts",
  },
} as const satisfies Record<string, PiExtensionRegistration>;

export type RegisteredPiExtensionId = keyof typeof PI_EXTENSION_REGISTRY;

export function isRegisteredPiExtensionId(value: unknown): value is RegisteredPiExtensionId {
  return typeof value === "string" && Object.hasOwn(PI_EXTENSION_REGISTRY, value);
}

export function registeredPiExtension(id: string): PiExtensionRegistration | null {
  return isRegisteredPiExtensionId(id) ? PI_EXTENSION_REGISTRY[id] : null;
}

export function piExtensionImageEntryPath(ext: PiExtensionRegistration): string {
  return `${PI_EXTENSION_IMAGE_ROOT}/${ext.package}/${ext.entry}`;
}

export function piExtensionWorkspacePath(id: string): string {
  return `${PI_EXTENSION_WORKSPACE_DIR}/${id}.ts`;
}

export function piExtensionSandboxPath(id: string): string {
  return `${PI_EXTENSION_SANDBOX_PREFIX}${id}.ts`;
}

export function parsePiExtensionIds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("pi_extensions 必须是字符串数组");
  if (value.length > PI_EXTENSION_MAX_PER_ROLE) {
    throw new Error(`pi_extensions 最多 ${PI_EXTENSION_MAX_PER_ROLE} 个`);
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !PI_EXTENSION_ID_PATTERN.test(item)) {
      throw new Error(`非法 Pi 扩展 id: ${String(item)}`);
    }
    if (seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

/** RoleConfig / transfer write gate. Non-Pi CLIs may only store an empty list. */
export function validatePiExtensionIds(ids: unknown, agentCli: string): string | null {
  let parsed: string[];
  try {
    parsed = parsePiExtensionIds(ids);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (parsed.length > 0 && agentCli !== "pi") {
    return "仅 agent_cli=pi 可声明 Pi 扩展";
  }
  for (const id of parsed) {
    if (!isRegisteredPiExtensionId(id)) return `未注册的 Pi 扩展: ${id}`;
  }
  return null;
}
