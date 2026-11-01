import { createHash } from "node:crypto";
import { registerHooks, type LoadHookSync } from "node:module";

/** Node, the installed loader chain and this preload are the trust boundary.
 * Install AFTER source-transforming loaders and BEFORE dynamically importing
 * the governed Scheduler graph. Do not install a transforming outer hook later.
 * This records the final nextLoad source, not signed deployment integrity,
 * successful evaluation, human truth or a passed quality assessment.
 * The preload cannot observe its own initial load; requiring it fails closed.
 */
export interface CapturedFindingQualitySource {
  readonly module_url: string;
  readonly source_digest: string;
  readonly source_byte_length: number;
  readonly source_format: "module" | "module-typescript";
  readonly integrity_basis: "node_sync_load_returned_source_under_trusted_preload";
}

const moduleOrigin = new URL(import.meta.url);
if (moduleOrigin.protocol !== "file:" || moduleOrigin.search || moduleOrigin.hash) {
  throw new Error("QUALITY_SOURCE_CAPTURE_PRELOAD_ORIGIN_INVALID");
}
const governedNames = [
  "identity", "identity-source-store", "identity-mapping-store",
  "strong-candidate-selector", "quality-contract", "quality-metrics",
  "quality-assets", "quality-store", "quality-ledger", "quality-state-store",
  "quality-worker", "quality-api", "relation-read", "relation-computation",
  "quality-source-capture",
] as const;
const governedUrls = new Set(governedNames.flatMap((name) =>
  ["ts", "js"].map((extension) => new URL(`./${name}.${extension}`, moduleOrigin).href)));
// Same implementation resource ceiling as quality assets; not a quality minimum.
const sourceBytesLimit = 1024 * 1024;
const captured = new Map<string, CapturedFindingQualitySource>();
let installed = false;
let failure: string | undefined;

function reject(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function rejectLoad(code: string): never {
  failure ??= code;
  return reject(failure);
}
function internalUrl(origin: string | URL): string {
  let url: URL;
  try { url = new URL(String(origin)); }
  catch { return reject("QUALITY_SOURCE_CAPTURE_ORIGIN_INVALID"); }
  if (url.search || url.hash || !governedUrls.has(url.href)) {
    return reject("QUALITY_SOURCE_CAPTURE_ORIGIN_INVALID");
  }
  return url.href;
}

const captureLoad: LoadHookSync = (url, context, nextLoad) => {
  const plain = new URL(url);
  plain.search = "";
  plain.hash = "";
  if (!governedUrls.has(plain.href)) return nextLoad(url, context);
  if (url !== plain.href) return rejectLoad("QUALITY_SOURCE_CAPTURE_ORIGIN_INVALID");
  if (failure) return reject(failure);
  let result: ReturnType<LoadHookSync>;
  try { result = nextLoad(url, context); }
  catch { return rejectLoad("QUALITY_SOURCE_CAPTURE_LOAD_FAILED"); }
  if (result.format !== "module" && result.format !== "module-typescript") {
    return rejectLoad("QUALITY_SOURCE_CAPTURE_FORMAT_UNSUPPORTED");
  }
  const source = result.source;
  let bytes: Buffer;
  if (typeof source === "string") bytes = Buffer.from(source, "utf8");
  else if (source instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(source));
  else if (ArrayBuffer.isView(source) && source.buffer instanceof ArrayBuffer) {
    bytes = Buffer.from(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  } else return rejectLoad("QUALITY_SOURCE_CAPTURE_SOURCE_UNAVAILABLE");
  if (!bytes.byteLength || bytes.byteLength > sourceBytesLimit) {
    return rejectLoad("QUALITY_SOURCE_CAPTURE_SIZE_INVALID");
  }
  const receipt: CapturedFindingQualitySource = Object.freeze({
    module_url: url,
    source_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    source_byte_length: bytes.byteLength,
    source_format: result.format,
    integrity_basis: "node_sync_load_returned_source_under_trusted_preload",
  });
  const previous = captured.get(url);
  if (previous && (previous.source_digest !== receipt.source_digest
    || previous.source_format !== receipt.source_format
    || previous.source_byte_length !== receipt.source_byte_length)) {
    return rejectLoad("QUALITY_SOURCE_CAPTURE_CONFLICT");
  }
  if (!previous) captured.set(url, receipt);
  // Do not retain a lower hook's mutable Buffer/ArrayBuffer alias. The evaluator
  // receives precisely this private byte copy; later outer transforms are TCB.
  return { ...result, source: bytes };
};

/** No options, caller allowlist, reset, replay or exposed deregistration handle. */
export function installFindingQualitySourceCapture(): void {
  if (arguments.length) reject("QUALITY_SOURCE_CAPTURE_INSTALL_ARGUMENTS_INVALID");
  if (installed) reject("QUALITY_SOURCE_CAPTURE_ALREADY_INSTALLED");
  installed = true;
  try { registerHooks({ load: captureLoad }); }
  catch { rejectLoad("QUALITY_SOURCE_CAPTURE_INSTALL_FAILED"); }
}

/** Internal module URLs only. Missing/late loads NEVER fall back to disk. */
export function requireCapturedFindingQualitySource(origin: string | URL): CapturedFindingQualitySource {
  const url = internalUrl(origin);
  if (!installed) reject("QUALITY_SOURCE_CAPTURE_NOT_INSTALLED");
  if (failure) reject(failure);
  const receipt = captured.get(url);
  if (!receipt) reject("QUALITY_SOURCE_CAPTURE_UNOBSERVED");
  return receipt;
}
