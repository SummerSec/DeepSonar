import { execFile, spawn } from "node:child_process";
import { createDecipheriv, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";
import postgres from "postgres";
import { normalizePreferredRegistry, selectAdmissionImageRef } from "./registry-ref.js";
import { resolveScannerImages, type ScannerName } from "./scanner-config.js";
import { shouldRevokeOnScanFailure } from "./trust-policy.js";

const execFileP = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL ?? "postgres://deepsonar:deepsonar@localhost:5432/deepsonar";
const workerId = process.env.DEEPSONAR_IMAGE_ADMISSION_WORKER_ID ?? `admission-${randomUUID().slice(0, 8)}`;
const pollMs = Math.max(1_000, Number(process.env.DEEPSONAR_IMAGE_ADMISSION_POLL_MS ?? 5_000));
const updateCheckMs = Math.max(60_000, Number(process.env.DEEPSONAR_IMAGE_UPDATE_CHECK_SEC ?? 21_600) * 1_000);
const continuousRescanMs = Math.max(60_000, Number(process.env.DEEPSONAR_IMAGE_RESCAN_SEC ?? 86_400) * 1_000);
const preferredRegistry = normalizePreferredRegistry(process.env.DEEPSONAR_IMAGE_REGISTRY ?? "");
const allowedRegistries = new Set((process.env.DEEPSONAR_ALLOWED_IMAGE_REGISTRIES ?? "ghcr.io,docker.io,registry-1.docker.io").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
const scannerImages = resolveScannerImages();
const scanVolume = process.env.DEEPSONAR_IMAGE_SCAN_VOLUME ?? "deepsonar_admission_scan";
const sql = postgres(databaseUrl, { max: 2, connection: { application_name: "deepsonar-image-admission" } });

function masterKey(): Buffer {
  const keyFile = process.env.DEEPSONAR_MASTER_KEY_FILE ?? "";
  const raw = keyFile && existsSync(keyFile)
    ? readFileSync(keyFile, "utf8").trim()
    : (process.env.DEEPSONAR_MASTER_KEY ?? "").trim();
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("image-admission cannot decrypt registry Credential: invalid master key");
  return key;
}

function decryptCredential(row: { ciphertext: string; nonce: string; auth_tag: string }): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(row.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function dockerLogin(registry: string, username: string, secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["login", registry, "--username", username, "--password-stdin"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`registry login failed (${code}): ${stderr.slice(0, 300)}`)));
    child.stdin.end(secret);
  });
}

async function registrySession(row: Record<string, unknown>): Promise<() => Promise<void>> {
  const seed = (row.scan_seed ?? {}) as Record<string, unknown>;
  const credentialId = seed.registry_credential_id as string | undefined;
  if (!credentialId) return async () => {};
  const [credential] = await sql`
    SELECT ciphertext, nonce, auth_tag, public_metadata_json FROM credentials
    WHERE id = ${credentialId} AND kind = 'oci_registry' AND status = 'active'`;
  if (!credential) throw new Error("registry Credential is unavailable");
  const metadata = credential.public_metadata_json as Record<string, unknown>;
  const registry = String(metadata.registry ?? "").trim().toLowerCase();
  const username = String(metadata.username ?? "").trim();
  if (registry !== registryOf((row.scan_image_ref ?? row.image_ref) as string) || !username) throw new Error("registry Credential metadata does not match image registry");
  await dockerLogin(registry, username, decryptCredential(credential as never));
  return async () => { await docker(["logout", registry], 30_000).catch(() => {}); };
}

function registryOf(imageRef: string): string {
  const first = imageRef.split("/")[0]?.toLowerCase() ?? "";
  return first.includes(".") || first.includes(":") ? first : "docker.io";
}

function requireImmutableScanner(name: ScannerName): string {
  return scannerImages[name];
}

async function docker(args: string[], timeout = 15 * 60_000, maxBuffer = 64 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileP("docker", args, { timeout, maxBuffer });
  return stdout.trim();
}

async function scanner(name: keyof typeof scannerImages, args: string[]): Promise<string> {
  return docker(["run", "--rm", "--network", "bridge", "-v", "/var/run/docker.sock:/var/run/docker.sock", requireImmutableScanner(name), ...args]);
}

async function claimScan(): Promise<Record<string, unknown> | null> {
  return sql.begin(async (tx) => {
    const [scan] = await tx`
      SELECT s.id, s.runtime_image_version_id
      FROM runtime_image_scans s
      WHERE s.status = 'queued'
      ORDER BY s.created_at
      FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!scan) return null;
    await tx`
      UPDATE runtime_image_scans SET status = 'claimed', worker_id = ${workerId},
        attempts = attempts + 1, started_at = now() WHERE id = ${scan.id as string}`;
    await tx`
      UPDATE runtime_image_versions SET
        trust_status = CASE WHEN trust_status = 'trusted' THEN 'trusted' ELSE 'scanning' END,
        updated_at = now()
      WHERE id = ${scan.runtime_image_version_id as string} AND trust_status <> 'revoked'`;
    const [row] = await tx`
      SELECT s.id AS scan_id, s.result_json AS scan_seed, v.*, ri.image_key, ri.source_kind
      FROM runtime_image_scans s
      JOIN runtime_image_versions v ON v.id = s.runtime_image_version_id
      JOIN runtime_images ri ON ri.id = v.runtime_image_id
      WHERE s.id = ${scan.id as string}`;
    const result = row as Record<string, unknown>;
    const refs = await tx`
      SELECT image_ref FROM runtime_image_version_refs
      WHERE version_id = ${result.id as string}`;
    try {
      result.scan_image_ref = selectAdmissionImageRef({
        sourceKind: String(result.source_kind),
        imageKey: String(result.image_key),
        imageRef: String(result.image_ref ?? ""),
        digest: typeof result.digest === "string" ? result.digest : null,
        preferredRegistry,
        registryRefs: refs.map((ref) => String(ref.image_ref)),
      });
    } catch (error) {
      result.scan_selection_error = error instanceof Error ? error.message : String(error);
    }
    return result;
  });
}

async function inspectAndScanAuthorized(row: Record<string, unknown>) {
  const scanId = row.scan_id as string;
  const versionId = row.id as string;
  if (row.scan_selection_error) throw new Error(String(row.scan_selection_error));
  const imageRef = row.scan_image_ref as string;
  const scanSeed = row.scan_seed && typeof row.scan_seed === "object"
    ? row.scan_seed as Record<string, unknown>
    : {};
  const restoreOfficialTrust = row.source_kind === "official" && scanSeed.restore_official_trust === true;
  if (!allowedRegistries.has(registryOf(imageRef))) throw new Error(`registry not allowed: ${registryOf(imageRef)}`);

  await sql`UPDATE runtime_image_scans SET status = 'running' WHERE id = ${scanId}`;
  await docker(["pull", imageRef]);
  const inspect = JSON.parse(await docker(["image", "inspect", imageRef]))[0] as Record<string, unknown>;
  const repoDigests = (inspect.RepoDigests as string[] | undefined) ?? [];
  const resolvedRef = /@sha256:[0-9a-f]{64}$/.test(imageRef) ? imageRef : repoDigests[0];
  if (!resolvedRef) throw new Error("registry did not provide immutable RepoDigest");
  const digest = resolvedRef.match(/@(sha256:[0-9a-f]{64})$/)?.[1];
  if (!digest) throw new Error("resolved image reference has no sha256 digest");
  const labels = (((inspect.Config as Record<string, unknown> | undefined)?.Labels ?? {}) as Record<string, string>);
  if (labels["io.deepsonar.contract"] !== "deepsonar.runtime.contract/v1") {
    throw new Error("missing or unsupported io.deepsonar.contract label");
  }
  if (labels["io.deepsonar.tools-manifest"] !== "/opt/deepsonar/tool-manifest.json") {
    throw new Error("tools manifest label must point to /opt/deepsonar/tool-manifest.json");
  }

  const hardening = ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "1g", "--pids-limit", "256", "--entrypoint", "sh", resolvedRef, "-lc"];
  const manifestText = await docker([...hardening, "cat /opt/deepsonar/tool-manifest.json && test -x /bin/sh && test -d /workspace"]);
  const manifest = JSON.parse(manifestText) as { contract?: string; tools?: unknown[]; platforms?: string[] };
  const toolsManifestSha256 = (await docker([...hardening, "sha256sum /opt/deepsonar/tool-manifest.json | cut -d' ' -f1"])).trim();
  if (manifest.contract !== "deepsonar.runtime.contract/v1" || !Array.isArray(manifest.tools)) {
    throw new Error("invalid tool manifest contract");
  }
  await docker([...hardening, "git --version && rg --version && jq --version && file --version && python3 --version && node --version"]);
  const setuid = (await docker([...hardening, "find / -xdev -type f -perm /6000 -print 2>/dev/null || true"])).split("\n").filter(Boolean);

  const probeId = await docker(["create", resolvedRef]);
  const archivePath = `/scan/${scanId}.tar`;
  try {
    await docker(["export", "-o", archivePath, probeId]);
    await docker([
      "run", "--rm", "--network", "none", "-v", `${scanVolume}:/scan:ro`,
      "--entrypoint", "clamscan", requireImmutableScanner("clamav"),
      "--infected", "--no-summary", archivePath,
    ], 30 * 60_000);
  } finally {
    await docker(["rm", "-f", probeId], 30_000).catch(() => {});
    await unlink(archivePath).catch(() => {});
  }

  const signature = JSON.parse(await scanner("cosign", ["verify", "--output", "json", resolvedRef]));
  const sbom = JSON.parse(await scanner("syft", [resolvedRef, "-o", "cyclonedx-json"]));
  const vulnerabilityReport = JSON.parse(await scanner("trivy", ["image", "--scanners", "vuln,secret", "--format", "json", "--severity", "HIGH,CRITICAL", resolvedRef]));
  const criticalCount = ((vulnerabilityReport.Results ?? []) as Array<{ Vulnerabilities?: Array<{ Severity?: string }> }>).flatMap((result) => result.Vulnerabilities ?? []).filter((item) => item.Severity === "CRITICAL").length;
  const secretCount = ((vulnerabilityReport.Results ?? []) as Array<{ Secrets?: unknown[] }>).reduce((sum, result) => sum + (result.Secrets?.length ?? 0), 0);
  if (criticalCount > 0 || secretCount > 0) throw new Error(`admission policy failed: critical=${criticalCount}, secrets=${secretCount}`);

  const platforms = [`${String(inspect.Os ?? "linux")}/${String(inspect.Architecture ?? "unknown")}`];
  const scanSummary = { contract: "passed", signature: "verified", malware: "clean", licenses: "captured-in-sbom", critical: criticalCount, secrets: secretCount, setuid, worker_id: workerId };
  await sql.begin(async (tx) => {
    await tx`
      UPDATE runtime_image_versions SET resolved_ref = ${resolvedRef}, digest = ${digest},
        platforms_json = ${tx.json(platforms as never)}, tools_json = ${tx.json(manifest.tools as never)},
        tools_manifest_sha256 = ${toolsManifestSha256},
        sbom_json = ${tx.json(sbom as never)}, signature_json = ${tx.json(signature as never)},
        scan_summary_json = ${tx.json(scanSummary as never)}, size_bytes = ${Number(inspect.Size ?? 0)},
        scanned_at = now(),
        trust_status = CASE WHEN trust_status = 'trusted' OR ${restoreOfficialTrust} THEN 'trusted' ELSE 'quarantined' END,
        approved_by = CASE WHEN ${restoreOfficialTrust} THEN 'official-catalog-rescan' ELSE approved_by END,
        approved_at = CASE WHEN ${restoreOfficialTrust} THEN now() ELSE approved_at END,
        status_reason = NULL, updated_at = now()
      WHERE id = ${versionId} AND trust_status <> 'revoked'`;
    await tx`
      UPDATE runtime_image_scans SET status = 'succeeded', result_json = ${tx.json({ ...scanSummary, resolved_ref: resolvedRef, digest } as never)},
        finished_at = now() WHERE id = ${scanId}`;
  });
}

async function inspectAndScan(row: Record<string, unknown>) {
  if (row.scan_selection_error) throw new Error(String(row.scan_selection_error));
  const closeRegistrySession = await registrySession(row);
  try { await inspectAndScanAuthorized(row); }
  finally { await closeRegistrySession(); }
}

async function writeAdmissionAudit(action: string, row: Record<string, unknown>, after: Record<string, unknown>, result = "ok") {
  await sql`
    INSERT INTO audit_logs ${sql({
      actor_type: "system",
      actor_id: "image-admission",
      action,
      project_id: null,
      resource_type: "runtime_image_version",
      resource_id: String(row.id ?? ""),
      request_id: null,
      ip: null,
      user_agent: null,
      before_json: sql.json({
        image_key: row.image_key ?? null,
        version: row.version ?? null,
        trust_status: row.trust_status ?? null,
      } as never),
      after_json: sql.json(after as never),
      result,
      error_code: result === "ok" ? null : action,
    })}`.catch((error) => {
    console.error(`[image-admission] audit failed ${action}:`, error instanceof Error ? error.message : error);
  });
}

async function fail(row: Record<string, unknown>, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const scanSeed = row.scan_seed && typeof row.scan_seed === "object"
    ? row.scan_seed as Record<string, unknown>
    : {};
  const restoreOfficialTrust = row.source_kind === "official" && scanSeed.restore_official_trust === true;
  const revoke = shouldRevokeOnScanFailure({
    sourceKind: row.source_kind,
    trustStatus: row.trust_status,
    restoreOfficialTrust,
    errorMessage: message,
  });
  const preserveOfficialTrust = row.source_kind === "official" && row.trust_status === "trusted" && !revoke;
  await sql.begin(async (tx) => {
    await tx`UPDATE runtime_image_scans SET status = 'failed', error = ${message}, finished_at = now() WHERE id = ${row.scan_id as string}`;
    if (preserveOfficialTrust) {
      await tx`
        UPDATE runtime_image_versions SET status_reason = ${message}, updated_at = now()
        WHERE id = ${row.id as string} AND trust_status = 'trusted'`;
      return;
    }
    await tx`
      UPDATE runtime_image_versions SET trust_status = ${revoke ? "revoked" : "rejected"},
        status_reason = ${message}, revoked_at = ${revoke ? new Date() : null}, updated_at = now()
      WHERE id = ${row.id as string} AND trust_status <> 'revoked'`;
  });
  if (preserveOfficialTrust) {
    console.error(`[image-admission] ${row.image_key as string}@${row.version as string}: scan failed; official trust preserved (${message})`);
    await writeAdmissionAudit("runtime_image.trust_preserved", row, {
      trust_status: "trusted",
      reason: "scan_failed_without_policy_violation",
      error: message.slice(0, 300),
    }, "error");
    return;
  }
  if (revoke) {
    const affected = await sql`
      UPDATE jobs SET status = 'cancelled', finished_at = now(), error = ${`runtime image automatically revoked: ${message}`}
      WHERE agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${row.id as string}
        AND status IN ('pending','claimed','provisioning','running','waiting_human')
      RETURNING sandbox_id`;
    for (const job of affected) {
      if (job.sandbox_id) await docker(["rm", "-f", job.sandbox_id as string], 30_000).catch(() => {});
    }
    await writeAdmissionAudit("runtime_image.revoked", row, {
      trust_status: "revoked",
      error: message.slice(0, 300),
    }, "ok");
  }
  console.error(`[image-admission] ${row.image_key as string}@${row.version as string}: ${message}`);
}

async function tick() {
  const row = await claimScan();
  if (!row) return;
  try { await inspectAndScan(row); }
  catch (error) { await fail(row, error); }
}

/** 只发现新 digest，不自动替换；新版本仍从 quarantined 开始。 */
async function checkTrackedTags() {
  const tracked = await sql`
    SELECT v.id, v.runtime_image_id, v.version, v.image_ref, v.digest
    FROM runtime_image_versions v
    JOIN runtime_images ri ON ri.id = v.runtime_image_id
    WHERE v.trust_status = 'trusted' AND ri.enabled = true
      AND v.image_ref !~ '@sha256:[0-9a-f]{64}$'`;
  for (const row of tracked) {
    try {
      await docker(["pull", row.image_ref as string]);
      const raw = JSON.parse(await docker(["image", "inspect", row.image_ref as string]))[0] as { RepoDigests?: string[] };
      const resolved = raw.RepoDigests?.[0];
      const digest = resolved?.match(/@(sha256:[0-9a-f]{64})$/)?.[1];
      if (!resolved || !digest || digest === row.digest) continue;
      await sql.begin(async (tx) => {
        const [version] = await tx`
          INSERT INTO runtime_image_versions ${tx({
            runtime_image_id: row.runtime_image_id,
            version: `discovered-${new Date().toISOString().slice(0, 10)}-${digest.slice(7, 15)}`,
            image_ref: row.image_ref,
            resolved_ref: resolved,
            digest,
            trust_status: "quarantined",
            imported_by: workerId,
          } as never)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO NOTHING RETURNING id`;
        if (version) await tx`INSERT INTO runtime_image_scans (runtime_image_version_id) VALUES (${version.id as string})`;
      });
    } catch (error) {
      console.warn(`[image-admission] update check failed for ${String(row.image_ref)}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** 可信版本周期复扫；扫描失败会自动 revoked，并终止仍活跃的相关 Job。 */
async function queueContinuousRescans() {
  await sql`
    INSERT INTO runtime_image_scans (runtime_image_version_id)
    SELECT v.id FROM runtime_image_versions v
    WHERE v.trust_status = 'trusted'
      AND COALESCE(v.scanned_at, '-infinity'::timestamptz) < now() - (${Math.round(continuousRescanMs / 1000)} * interval '1 second')
      AND NOT EXISTS (
        SELECT 1 FROM runtime_image_scans s WHERE s.runtime_image_version_id = v.id
          AND s.status IN ('queued','claimed','running')
      )`;
}

console.log(`[image-admission] worker=${workerId} poll=${pollMs}ms`);
const timer = setInterval(() => void tick().catch((error) => console.error("[image-admission] tick failed", error)), pollMs);
const updateTimer = setInterval(() => void checkTrackedTags().catch((error) => console.error("[image-admission] update check failed", error)), updateCheckMs);
const rescanTimer = setInterval(() => void queueContinuousRescans().catch((error) => console.error("[image-admission] rescan queue failed", error)), continuousRescanMs);
void tick();
void queueContinuousRescans();
const shutdown = async () => { clearInterval(timer); clearInterval(updateTimer); clearInterval(rescanTimer); await sql.end(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
