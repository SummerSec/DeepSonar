import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isOfficialRuntimeImageKey } from "./runtime-image-manual.js";

const execFileP = promisify(execFile);
const INSPECT_MAX_BYTES = 512 * 1024;
const INSPECT_TIMEOUT_MS = 10_000;
const RUNTIME_IMAGE_CONTRACT = "deepsonar.runtime.contract/v1";
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

function localImageDigest(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return DIGEST_RE.test(normalized) ? normalized : null;
}

function immutableDigest(value: string): string | null {
  const match = value.trim().match(/@?(sha256:[0-9a-f]{64})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function sanitizeRuntimeImageError(value: unknown, maxBytes = 8 * 1024): string {
  let text = value instanceof Error ? value.message : String(value ?? "");
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, "$1<redacted>@");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${text.slice(0, Math.floor(maxBytes * 0.9))} …[truncated]`;
}

export interface RuntimeImageLocalInspection {
  image_ref: string;
  exists: boolean;
  image_id: string | null;
  repo_digests: string[];
  os: string | null;
  arch: string | null;
  labels: {
    contract: string | null;
    image_key: string | null;
    tool_manifest: string | null;
    tool_manifest_label: "io.deepsonar.tool-manifest" | "io.deepsonar.tools-manifest" | null;
    manual_index: string | null;
    toolset: string | null;
  };
  contract_matches: boolean;
  matches_product: boolean;
  tool_manifest_matches: boolean;
  manual_index_matches: boolean;
  immutable_ref: string | null;
  can_adopt: boolean;
  reasons: string[];
  error: string | null;
}

const TOOLSET_TO_RUNTIME_IMAGE_KEY: Record<string, string> = {
  base: "deepsonar-base",
  audit: "deepsonar-audit",
  "kali-minimal": "deepsonar-kali-minimal",
  "openharmony-test": "deepsonar-openharmony-test",
  "openharmony-audit": "deepsonar-openharmony-audit",
  "openharmony-fuzz": "deepsonar-openharmony-fuzz",
  "chrome-audit": "deepsonar-chrome-audit",
  "chrome-test": "deepsonar-chrome-test",
  "chrome-fuzz": "deepsonar-chrome-fuzz",
  "clickhouse-audit": "deepsonar-clickhouse-audit",
  "clickhouse-test": "deepsonar-clickhouse-test",
  "clickhouse-fuzz": "deepsonar-clickhouse-fuzz",
  mobile: "deepsonar-mobile",
};

function imageRepository(imageRef: string): string | null {
  const value = imageRef.trim().replace(/@sha256:[0-9a-f]{64}$/i, "");
  if (!value) return null;
  const lastSlash = value.lastIndexOf("/");
  const lastColon = value.lastIndexOf(":");
  return (lastColon > lastSlash ? value.slice(0, lastColon) : value).toLowerCase();
}

function localInspectionSkeleton(imageRef: string, reasons: string[], error: string | null): RuntimeImageLocalInspection {
  return {
    image_ref: imageRef,
    exists: false,
    image_id: null,
    repo_digests: [],
    os: null,
    arch: null,
    labels: { contract: null, image_key: null, tool_manifest: null, tool_manifest_label: null, manual_index: null, toolset: null },
    contract_matches: false,
    matches_product: false,
    tool_manifest_matches: false,
    manual_index_matches: false,
    immutable_ref: null,
    can_adopt: false,
    reasons,
    error,
  };
}

/** Read-only Docker label inspection; adoption also requires the canonical manual label for official products. */
export async function inspectLocalRuntimeImage(
  imageRef: string,
  productKey: string,
  knownImageRefs: string[] = [],
): Promise<RuntimeImageLocalInspection> {
  const normalizedRef = imageRef.trim();
  try {
    const result = await execFileP("docker", ["image", "inspect", normalizedRef], {
      shell: false,
      windowsHide: true,
      timeout: INSPECT_TIMEOUT_MS,
      maxBuffer: INSPECT_MAX_BYTES,
    });
    const parsed = JSON.parse(result.stdout) as unknown;
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!item || typeof item !== "object") throw new Error("docker image inspect returned an invalid shape");
    const raw = item as Record<string, unknown>;
    const config = raw.Config && typeof raw.Config === "object" ? raw.Config as Record<string, unknown> : {};
    const rawLabels = config.Labels && typeof config.Labels === "object" ? config.Labels as Record<string, unknown> : {};
    const labels = Object.fromEntries(Object.entries(rawLabels).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    const imageId = typeof raw.Id === "string" && localImageDigest(raw.Id) ? raw.Id.toLowerCase() : null;
    const repoDigests = Array.isArray(raw.RepoDigests)
      ? raw.RepoDigests.filter((value): value is string => typeof value === "string" && immutableDigest(value) !== null)
      : [];
    const contract = labels["io.deepsonar.contract"] ?? null;
    const explicitImageKey = labels["io.deepsonar.image-key"] ?? null;
    const toolset = labels["io.deepsonar.toolset"] ?? null;
    const toolManifestLabel = labels["io.deepsonar.tool-manifest"] !== undefined
      ? "io.deepsonar.tool-manifest"
      : labels["io.deepsonar.tools-manifest"] !== undefined ? "io.deepsonar.tools-manifest" : null;
    const toolManifest = toolManifestLabel ? labels[toolManifestLabel] ?? null : null;
    const manualIndex = labels["io.deepsonar.manuals"] ?? null;
    const compatibleImageKey = explicitImageKey ?? (toolset ? TOOLSET_TO_RUNTIME_IMAGE_KEY[toolset] ?? null : null);
    const knownRepositories = knownImageRefs.map(imageRepository).filter((value): value is string => Boolean(value));
    const matchingRepoDigest = repoDigests.find((value) => {
      const repository = imageRepository(value);
      return repository !== null && knownRepositories.includes(repository);
    }) ?? null;
    const immutableRef = matchingRepoDigest ?? imageId;
    const reasons: string[] = [];
    const contractMatches = contract === RUNTIME_IMAGE_CONTRACT;
    const matchesProduct = compatibleImageKey === productKey;
    const toolManifestMatches = toolManifest === "/opt/deepsonar/tool-manifest.json";
    const manualIndexMatches = manualIndex === "/opt/deepsonar/manuals/index.json";
    const manualRequired = isOfficialRuntimeImageKey(productKey);
    if (!contractMatches) reasons.push("contract_mismatch");
    if (!matchesProduct) reasons.push(explicitImageKey ? "image_key_mismatch" : toolset ? "toolset_mismatch" : "image_key_and_toolset_missing");
    if (!toolManifestMatches) reasons.push("tool_manifest_mismatch");
    if (manualRequired && !manualIndexMatches) reasons.push("manual_index_mismatch");
    if (!matchingRepoDigest && !imageId) reasons.push("immutable_ref_unavailable");
    if (!explicitImageKey && compatibleImageKey === productKey) reasons.push("legacy_toolset_label_accepted");
    const canAdopt = Boolean(imageId && immutableRef && contractMatches && matchesProduct && toolManifestMatches && (!manualRequired || manualIndexMatches));
    if (canAdopt) reasons.push("ready_for_adoption");
    return {
      image_ref: normalizedRef,
      exists: true,
      image_id: imageId,
      repo_digests: repoDigests,
      os: typeof raw.Os === "string" ? raw.Os : null,
      arch: typeof raw.Architecture === "string" ? raw.Architecture : null,
      labels: {
        contract,
        image_key: explicitImageKey,
        tool_manifest: toolManifest,
        tool_manifest_label: toolManifestLabel,
        manual_index: manualIndex,
        toolset,
      },
      contract_matches: contractMatches,
      matches_product: matchesProduct,
      tool_manifest_matches: toolManifestMatches,
      manual_index_matches: manualIndexMatches,
      immutable_ref: immutableRef,
      can_adopt: canAdopt,
      reasons,
      error: null,
    };
  } catch (error) {
    const rawError = error as { stderr?: unknown };
    const detail = sanitizeRuntimeImageError(rawError.stderr || error);
    const notFound = /no such (image|object)|unable to find image|not found/i.test(detail);
    return localInspectionSkeleton(normalizedRef, [notFound ? "image_not_found" : "docker_inspect_failed"], detail || "docker image inspect failed");
  }
}
