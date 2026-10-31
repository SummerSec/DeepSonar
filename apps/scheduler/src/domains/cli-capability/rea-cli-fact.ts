import { createHash } from "node:crypto";
import { z } from "zod";
import { EmitFactDirectPayload } from "@deepsonar/shared-types";
import { invalidControlPayload } from "../../control-input.js";
import { sql } from "../../db.js";
import { readSharedAssetBlob, normalizeAssetKey } from "../shared-assets/index.js";
import { assertFrozenCliCapabilities } from "./frozen.js";
import { REA_CLI_ARTIFACT_EXTENSION, REA_CLI_CAPABILITY_ID, buildReaCliCapabilityResult, buildReaCliFactProposal } from "./rea-cli-evidence.js";

export const ReaObservationArchive = z.object({
  schema: z.literal("deepsonar.rea-observation/v1"),
  job_id: z.string().uuid(), attempt_id: z.string().uuid(),
  operation: z.enum(["analyze", "search", "function", "decompile", "instructions", "xrefs", "trace-native-values", "inspect-analysis-view"]),
  sample_path: z.string().max(1024).startsWith("/workspace/").refine((value) => !value.includes("\\") && !value.includes("\0") && !value.split("/").slice(2).some((part) => !part || part === "." || part === "..")), sample_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  image_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  tool_versions: z.object({ rea: z.literal("6.4.0"), ghidra: z.literal("12.1.4"), java: z.string().min(1).max(100) }).strict(),
  argv: z.array(z.string().min(1).max(4000)).min(1).max(64),
  exit_code: z.number().int().min(-1).max(255).nullable(),
  stdout: z.string().max(4_194_304), stderr: z.string().max(4_194_304),
  stdout_truncated: z.boolean(), stderr_truncated: z.boolean(), timed_out: z.boolean(), cancelled: z.boolean(),
  analysis_limits: z.object({ timeout_ms: z.number().int().positive().max(600_000), max_output_bytes: z.number().int().positive().max(4_194_304), note: z.string().min(1).max(500) }).strict(),
}).strict();

/** Only explicitly namespaced REA observations use this archive contract. */
export async function normalizeArchivedReaFact(
  jobId: string, payload: unknown,
  dependencies: { db: typeof sql; readBlob: typeof readSharedAssetBlob } = { db: sql, readBlob: readSharedAssetBlob },
): Promise<unknown> {
  const { db, readBlob } = dependencies;
  const input = EmitFactDirectPayload.safeParse(payload);
  if (!input.success) return payload;
  const extension = input.data.artifact?.extensions?.[REA_CLI_ARTIFACT_EXTENSION];
  if (extension === undefined) return payload;
  const reject = (message: string): never => { throw invalidControlPayload(message, "artifact.extensions.binary.rea-cli"); };
  if (!extension || typeof extension !== "object" || Array.isArray(extension)) reject("REA observation must name a published evidence_key");
  const key = (extension as Record<string, unknown>).evidence_key;
  if (typeof key !== "string" || !key || input.data.verification) reject("REA observation needs evidence_key and cannot submit a verification verdict");
  try { if (normalizeAssetKey(String(key)) !== key) reject("REA evidence_key must be a canonical asset key"); }
  catch { return reject("REA evidence_key must be a canonical asset key"); }
  const [job] = await db`SELECT j.agent_snapshot_json, a.id AS attempt_id, a.started_at AS attempt_started_at
    FROM jobs j JOIN job_attempts a ON a.job_id=j.id AND a.status='active'
    WHERE j.id=${jobId} AND j.status='running'`;
  if (!job) reject("REA observation requires a running Job and active Attempt");
  const snapshot = job.agent_snapshot_json as Record<string, any>;
  assertFrozenCliCapabilities(snapshot);
  const capability = snapshot.cli_capabilities?.find((item: { id: string }) => item.id === REA_CLI_CAPABILITY_ID);
  if (!capability) reject("binary.rea.cli was not frozen for this Job");
  if (input.data.artifact?.claims?.some((claim) => claim.status !== "unknown")
    || input.data.artifact?.evidence?.some((item) => item.polarity !== "unknown")) reject("REA claims and evidence must stay unknown");
  const [asset] = await db`SELECT v.id, b.blob_uri, v.content_sha256, v.bytes
    FROM shared_assets s JOIN shared_asset_versions v ON v.asset_id=s.id AND v.version=s.current_version
    JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
    JOIN jobs j ON j.id=${jobId}
    WHERE s.scope_type='project' AND s.project_id=j.project_id AND s.logical_key=${String(key)}
      AND s.created_by_job_id=j.id AND v.created_by_job_id=j.id AND s.status='active'
      AND v.created_at >= ${job.attempt_started_at}`;
  if (!asset) reject("REA evidence must be published by this Job before emit_fact");
  if (Number(asset.bytes) > 10_000_000) reject("REA evidence archive exceeds the 10 MB archive limit");
  const bytes = await readBlob(String(asset.blob_uri));
  if (bytes.byteLength !== Number(asset.bytes) || bytes.byteLength > 10_000_000) reject("REA archive byte count mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== String(asset.content_sha256)) reject("REA evidence content digest mismatch");
  let archive: z.infer<typeof ReaObservationArchive>;
  try { archive = ReaObservationArchive.parse(JSON.parse(bytes.toString("utf8"))); }
  catch { return reject("REA evidence archive is missing required provenance or has an invalid schema"); }
  if (archive.job_id !== jobId || archive.attempt_id !== String(job.attempt_id)
    || archive.image_digest !== snapshot.runtime_image?.image_digest
    || archive.analysis_limits.timeout_ms > capability.limits.timeout_ms
    || archive.analysis_limits.max_output_bytes > capability.limits.max_output_bytes) {
    reject("REA evidence does not match the frozen Job/Attempt/image/budget");
  }
  const result = buildReaCliCapabilityResult({ ...archive, workspace: "/workspace", max_output_bytes: archive.analysis_limits.max_output_bytes,
    evidence_ref: `shared-asset-version:${String(asset.id)}` });
  const proposal = buildReaCliFactProposal(result, archive);
  proposal.artifact!.evidence![0]!.sha256 = String(asset.content_sha256);
  Object.assign(proposal.artifact!.extensions![REA_CLI_ARTIFACT_EXTENSION] as object, {
    provenance_kind: "agent_reported_observation", attempt_id: archive.attempt_id, evidence_version_id: String(asset.id), evidence_sha256: String(asset.content_sha256),
    tool_versions: archive.tool_versions, analysis_limits: archive.analysis_limits,
  });
  return proposal;
}
