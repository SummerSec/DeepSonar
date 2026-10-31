import { createHash } from "node:crypto";
import {
  PI_EXTENSION_IMAGE_ROOT,
  PI_EXTENSION_SANDBOX_PREFIX,
  parsePiExtensionIds,
  piExtensionImageEntryPath,
  piExtensionSandboxPath,
  piExtensionWorkspacePath,
  registeredPiExtension,
  validatePiExtensionIds,
  type PiExtensionRegistration,
} from "@deepsonar/shared-types";

export interface FrozenPiExtension {
  id: string;
  package: string;
  version: string;
  integrity: string;
  entry_path: string;
  workspace_path: string;
  requires_egress: boolean;
  compatible_image_keys: string[];
}

export interface MaterializedPiExtensionFile {
  path: string;
  content: string;
  content_sha256: string;
}

export interface PiExtensionInjection {
  files: MaterializedPiExtensionFile[];
  paths: string[];
  injected: Array<{ id: string; path: string; sha256: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

export { parsePiExtensionIds, validatePiExtensionIds };

export function piExtensionLoaderSource(entryPath: string): string {
  if (
    !entryPath.startsWith(`${PI_EXTENSION_IMAGE_ROOT}/`)
    || entryPath.includes("/../")
    || entryPath.includes("\0")
  ) {
    throw new Error("PI_EXTENSION_ENTRY_PATH_INVALID");
  }
  return `export { default } from ${JSON.stringify(entryPath)};\n`;
}

function freezeOne(ext: PiExtensionRegistration, imageKey: string | null): FrozenPiExtension {
  if (imageKey && !ext.compatible_image_keys.includes(imageKey)) {
    throw new Error(`Pi 扩展 ${ext.id} 与镜像 ${imageKey} 不兼容`);
  }
  return {
    id: ext.id,
    package: ext.package,
    version: ext.version,
    integrity: ext.integrity,
    entry_path: piExtensionImageEntryPath(ext),
    workspace_path: piExtensionWorkspacePath(ext.id),
    requires_egress: ext.requires_egress,
    compatible_image_keys: [...ext.compatible_image_keys],
  };
}

/** Job-create freeze. Unknown IDs and incompatible images fail closed. */
export function freezePiExtensions(
  ids: unknown,
  agentCli: string,
  imageKey: string | null,
): FrozenPiExtension[] {
  const error = validatePiExtensionIds(ids, agentCli);
  if (error) throw new Error(error);
  if (agentCli !== "pi") return [];
  return parsePiExtensionIds(ids).map((id) => {
    const ext = registeredPiExtension(id);
    if (!ext) throw new Error(`未注册的 Pi 扩展: ${id}`);
    return freezeOne(ext, imageKey);
  });
}

export function parseFrozenPiExtensions(value: unknown): FrozenPiExtension[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("冻结 pi_extensions 必须是数组");
  return value.map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
    if (!row || typeof row.id !== "string") throw new Error("冻结 Pi 扩展缺少 id");
    const ext = registeredPiExtension(row.id);
    if (!ext) throw new Error(`冻结了未注册的 Pi 扩展: ${row.id}`);
    if (row.package !== ext.package || row.version !== ext.version || row.integrity !== ext.integrity) {
      throw new Error(`冻结 Pi 扩展 ${row.id} 与当前注册表不一致`);
    }
    const entryPath = typeof row.entry_path === "string" ? row.entry_path : "";
    if (entryPath !== piExtensionImageEntryPath(ext)) {
      throw new Error(`冻结 Pi 扩展 ${row.id} 入口路径非法`);
    }
    const workspacePath = typeof row.workspace_path === "string" ? row.workspace_path : "";
    if (workspacePath !== piExtensionWorkspacePath(ext.id)) {
      throw new Error(`冻结 Pi 扩展 ${row.id} 工作区路径非法`);
    }
    return freezeOne(ext, null);
  });
}

export function materializeFrozenPiExtensions(
  frozen: readonly FrozenPiExtension[],
  allowEgress: boolean,
): PiExtensionInjection {
  const files: MaterializedPiExtensionFile[] = [];
  const paths: string[] = [];
  const injected: PiExtensionInjection["injected"] = [];
  const skipped: PiExtensionInjection["skipped"] = [];
  for (const ext of frozen) {
    if (ext.requires_egress && !allowEgress) {
      skipped.push({ id: ext.id, reason: "requires_egress" });
      continue;
    }
    const content = piExtensionLoaderSource(ext.entry_path);
    const content_sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    files.push({ path: ext.workspace_path, content, content_sha256 });
    const sandboxPath = piExtensionSandboxPath(ext.id);
    if (!sandboxPath.startsWith(PI_EXTENSION_SANDBOX_PREFIX)) {
      throw new Error("PI_EXTENSION_PATH_INVALID");
    }
    paths.push(sandboxPath);
    injected.push({ id: ext.id, path: ext.workspace_path, sha256: content_sha256 });
  }
  return { files, paths, injected, skipped };
}
