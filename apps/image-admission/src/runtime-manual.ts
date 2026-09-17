/** Pure validation for the offline manual metadata shipped in runtime images. */

export const RUNTIME_MANUAL_CONTRACT = "deepsonar.runtime.manuals/v1" as const;
export const RUNTIME_MANUAL_INDEX_PATH = "/opt/deepsonar/manuals/index.json" as const;
export const RUNTIME_MANUAL_LABEL = "io.deepsonar.manuals" as const;

export interface RuntimeManualMetadata {
  contract: typeof RUNTIME_MANUAL_CONTRACT;
  path: typeof RUNTIME_MANUAL_INDEX_PATH;
  version: string;
  sha256: string;
  count: number;
}

export interface RuntimeManualIndex {
  contract: typeof RUNTIME_MANUAL_CONTRACT;
  image_key: string;
  manual_version: string;
  path: typeof RUNTIME_MANUAL_INDEX_PATH;
  entries: Array<Record<string, unknown>>;
  manual_sha256: string;
  index_sha256?: string;
}

function invalid(message: string): never {
  throw new Error(`runtime manual: ${message}`);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function validateRuntimeManualMetadata(value: unknown): RuntimeManualMetadata {
  const raw = objectValue(value, "metadata");
  const unknown = Object.keys(raw).filter((key) => !["contract", "path", "version", "sha256", "count"].includes(key));
  if (unknown.length > 0) invalid(`metadata contains unknown fields: ${unknown.join(", ")}`);
  if (raw.contract !== RUNTIME_MANUAL_CONTRACT) invalid("metadata contract is invalid");
  if (raw.path !== RUNTIME_MANUAL_INDEX_PATH) invalid("metadata path is invalid");
  if (typeof raw.version !== "string" || raw.version.trim() === "") invalid("metadata version is invalid");
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) invalid("metadata sha256 is invalid");
  if (!Number.isSafeInteger(raw.count) || (raw.count as number) < 0) invalid("metadata count is invalid");
  return {
    contract: RUNTIME_MANUAL_CONTRACT,
    path: RUNTIME_MANUAL_INDEX_PATH,
    version: raw.version,
    sha256: raw.sha256,
    count: raw.count as number,
  };
}

export function validateRuntimeManualIndex(value: unknown): RuntimeManualIndex {
  const raw = objectValue(value, "index");
  if (raw.contract !== RUNTIME_MANUAL_CONTRACT) invalid("index contract is invalid");
  if (typeof raw.image_key !== "string" || raw.image_key.trim() === "") invalid("index image_key is invalid");
  if (typeof raw.manual_version !== "string" || raw.manual_version.trim() === "") invalid("index manual_version is invalid");
  if (raw.path !== RUNTIME_MANUAL_INDEX_PATH) invalid("index path is invalid");
  if (!Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) invalid("index entries are invalid");
  if (typeof raw.manual_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.manual_sha256)) invalid("index manual_sha256 is invalid");
  if (raw.index_sha256 !== undefined && (typeof raw.index_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.index_sha256))) invalid("index index_sha256 is invalid");
  return {
    contract: RUNTIME_MANUAL_CONTRACT,
    image_key: raw.image_key,
    manual_version: raw.manual_version,
    path: RUNTIME_MANUAL_INDEX_PATH,
    entries: raw.entries as Array<Record<string, unknown>>,
    manual_sha256: raw.manual_sha256,
    ...(typeof raw.index_sha256 === "string" ? { index_sha256: raw.index_sha256 } : {}),
  };
}

export function validateRuntimeManualPair(metadataValue: unknown, indexValue: unknown, expectedImageKey?: string): RuntimeManualMetadata {
  const metadata = validateRuntimeManualMetadata(metadataValue);
  const index = validateRuntimeManualIndex(indexValue);
  if (expectedImageKey && index.image_key !== expectedImageKey) invalid("index image_key does not match the runtime image product");
  if (metadata.sha256 !== index.manual_sha256) invalid("index manual_sha256 does not match metadata");
  if (metadata.version !== index.manual_version) invalid("index manual_version does not match metadata");
  if (metadata.count !== index.entries.length) invalid("index entry count does not match metadata");
  return metadata;
}

export function assertRuntimeManualLabel(labels: Record<string, unknown>, required: boolean): void {
  const raw = labels[RUNTIME_MANUAL_LABEL];
  if (raw !== undefined && raw !== RUNTIME_MANUAL_INDEX_PATH) invalid("manual label must point to /opt/deepsonar/manuals/index.json");
  if (required && raw !== RUNTIME_MANUAL_INDEX_PATH) invalid("official image is missing the runtime manual label");
}
