import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export interface EvidenceReadBudget { bytes: number }
export const criterionEvidenceBudget = (): EvidenceReadBudget => ({ bytes: 8 * 1024 * 1024 });

async function boundedRead(file: string, root: string, maxBytes: number, budget: EvidenceReadBudget): Promise<Buffer> {
  const resolved = await realpath(file);
  if (resolved !== path.resolve(file) || !resolved.startsWith(root + path.sep)) throw new Error("scope");
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes || stat.size + 1 > budget.bytes) throw new Error("budget");
    // Reserve even failed reads, including the extra byte used to detect concurrent growth.
    budget.bytes -= stat.size + 1;
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) throw new Error("changed");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Hash retained bytes only: never fetch agent URIs or read outside the authoritative Job/Attempt. */
export async function inspectCriterionEvidence(
  jobId: string, attemptId: string, evidence: readonly { id: string; uri: string | null; sha256: string | null }[],
  budget: EvidenceReadBudget, blobDir?: string,
): Promise<{ ids: string[]; digests: string[]; reasons: string[] }> {
  if (!evidence.length || evidence.length > 8) return { ids: [], digests: [], reasons: ["evidence_missing_or_over_limit"] };
  const reasons: string[] = [];
  const digests: string[] = [];
  try {
    const blobRoot = await realpath(blobDir ?? (await import("../../config.js")).config.storage.blobDir);
    const jobRoot = await realpath(path.join(blobRoot, "jobs", jobId));
    if (jobRoot !== path.join(blobRoot, "jobs", jobId)) throw new Error("scope");
    const raw = await boundedRead(path.join(jobRoot, "manifest.json"), jobRoot, 256 * 1024, budget);
    const manifest = JSON.parse(raw.toString("utf8"));
    if (manifest.job_id !== jobId || !manifest.finalized_at || manifest.inflight || manifest.synthetic || manifest.capture_error || manifest.truncated || !Array.isArray(manifest.files)) {
      throw new Error("manifest");
    }
    for (const item of evidence) {
      const uri = item.uri ?? "";
      const relative = uri.startsWith(`jobs/${jobId}/`) ? uri.slice(`jobs/${jobId}/`.length) : uri;
      if (!relative.startsWith(`attempts/${attemptId}/`) || relative.includes("\\") || relative.split("/").some((part) => part === ".." || part === "." || !part)) {
        reasons.push("evidence_scope_mismatch"); continue;
      }
      const files = manifest.files.filter((file: { path?: unknown }) => file.path === relative);
      if (files.length !== 1 || files[0].inflight || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "") || files[0].sha256 !== item.sha256) {
        reasons.push("evidence_manifest_mismatch"); continue;
      }
      const bytes = await boundedRead(path.join(jobRoot, relative), jobRoot, 2 * 1024 * 1024, budget);
      const digest = createHash("sha256").update(bytes).digest("hex");
      digests.push(digest);
      if (digest !== item.sha256 || bytes.length !== files[0].bytes) reasons.push("evidence_content_mismatch");
    }
  } catch { reasons.push("evidence_unavailable_or_budget_exceeded"); }
  return { ids: evidence.map((item) => item.id), digests, reasons: [...new Set(reasons)] };
}
