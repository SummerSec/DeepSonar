import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { sql } from "./db.js";

export const RUNTIME_IMAGE_CONTRACT = "deepsonar.runtime.contract/v1";
export const RUNTIME_IMAGE_REGISTRY_SCHEMA = "deepsonar.registry/v1";
const OFFICIAL_RUNTIME_IMAGE_REGISTRY_URL = "https://github.com/SummerSec/DeepSonar/releases/latest/download/runtime-image-registry.json";
const OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const RUNTIME_IMAGE_REGISTRY_MAX_BYTES = 1024 * 1024;
const RUNTIME_IMAGE_REGISTRY_CACHE_MS = 5 * 60_000;

export interface RuntimeImageRegistryVersion {
  version: string;
  image_ref: string;
  tools_manifest_sha256?: string;
  platforms?: string[];
  size_bytes?: number;
}

export interface RuntimeImageRegistryImage {
  image_key: string;
  name: string;
  description: string;
  publisher: string;
  source_kind: "official";
  source_url?: string;
  project_opt_in: boolean;
  default_role?: string;
  versions: RuntimeImageRegistryVersion[];
}

export interface RuntimeImageRegistry {
  schema: typeof RUNTIME_IMAGE_REGISTRY_SCHEMA;
  images: RuntimeImageRegistryImage[];
}

export interface RuntimeImageCatalogSyncResult {
  registry: RuntimeImageRegistry;
  product_count: number;
  version_count: number;
  synced_at: string;
}

export interface RuntimeImagePullItem {
  image_key: string;
  image_ref: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
}

export interface RuntimeImagePullTask {
  task_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  started_at: string | null;
  finished_at: string | null;
  total: number;
  completed: number;
  items: RuntimeImagePullItem[];
}

let runtimeImagePullTask: RuntimeImagePullTask | null = null;
let remoteRegistryCache: { registry: RuntimeImageRegistry | null; checked_at: number } | null = null;

export interface RuntimeImageSnapshot {
  runtime_image_id: string | null;
  runtime_image_version_id: string | null;
  image_key: string;
  image_ref: string;
  image_digest: string;
  tools_manifest_sha256: string | null;
  admission_scan_id: string | null;
  contract_version: string;
  source_kind: "official" | "third_party" | "fake";
  trust_status: "trusted" | "fake";
}

export function immutableDigest(imageRef: string): string | null {
  const match = imageRef.trim().match(/@(sha256:[0-9a-f]{64})$/);
  return match?.[1] ?? null;
}

export function localImageDigest(imageRef: string): string | null {
  const match = imageRef.trim().match(/^sha256:[0-9a-f]{64}$/);
  return match?.[0] ?? null;
}

function fakeSnapshot(imageKey: string): RuntimeImageSnapshot {
  const digest = `sha256:${createHash("sha256").update(`fake:${imageKey}`).digest("hex")}`;
  return {
    runtime_image_id: null,
    runtime_image_version_id: null,
    image_key: imageKey,
    image_ref: `fake://${imageKey}@${digest}`,
    image_digest: digest,
    tools_manifest_sha256: null,
    admission_scan_id: null,
    contract_version: RUNTIME_IMAGE_CONTRACT,
    source_kind: "fake",
    trust_status: "fake",
  };
}

function parseRegistry(raw: unknown): RuntimeImageRegistry {
  if (!raw || typeof raw !== "object") throw new Error("runtime-image-registry.json 必须是对象");
  const value = raw as Record<string, unknown>;
  if (value.schema !== RUNTIME_IMAGE_REGISTRY_SCHEMA || !Array.isArray(value.images)) {
    throw new Error(`runtime-image-registry.json schema 必须为 ${RUNTIME_IMAGE_REGISTRY_SCHEMA}`);
  }
  const images = value.images.map((entry, imageIndex): RuntimeImageRegistryImage => {
    if (!entry || typeof entry !== "object") throw new Error(`注册表 images[${imageIndex}] 无效`);
    const image = entry as Record<string, unknown>;
    const key = typeof image.image_key === "string" ? image.image_key : "";
    const versionsRaw = image.versions;
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(key) || typeof image.name !== "string" || typeof image.description !== "string"
      || typeof image.publisher !== "string" || image.source_kind !== "official" || !Array.isArray(versionsRaw)) {
      throw new Error(`注册表 images[${imageIndex}] 字段无效`);
    }
    const versions = versionsRaw.map((version, versionIndex) => {
      if (!version || typeof version !== "object") throw new Error(`注册表 ${key} versions[${versionIndex}] 无效`);
      const item = version as Record<string, unknown>;
      const imageRef = typeof item.image_ref === "string" ? item.image_ref.trim() : "";
      if (!item.version || typeof item.version !== "string" || !immutableDigest(imageRef)) {
        throw new Error(`注册表 ${key} versions[${versionIndex}] 必须使用 @sha256:64hex`);
      }
      return {
        version: item.version,
        image_ref: imageRef as string,
        ...(typeof item.tools_manifest_sha256 === "string" ? { tools_manifest_sha256: item.tools_manifest_sha256 } : {}),
        ...(Array.isArray(item.platforms) && item.platforms.every((v) => typeof v === "string") ? { platforms: item.platforms as string[] } : {}),
        ...(typeof item.size_bytes === "number" ? { size_bytes: item.size_bytes } : {}),
      };
    });
    return {
      image_key: key,
      name: typeof image.name === "string" ? image.name : key,
      description: typeof image.description === "string" ? image.description : "",
      publisher: typeof image.publisher === "string" ? image.publisher : "",
      source_kind: "official",
      ...(typeof image.source_url === "string" ? { source_url: image.source_url } : {}),
      project_opt_in: image.project_opt_in === true,
      ...(typeof image.default_role === "string" ? { default_role: image.default_role } : {}),
      versions,
    };
  });
  return { schema: RUNTIME_IMAGE_REGISTRY_SCHEMA, images };
}

async function loadBundledRuntimeImageRegistry(): Promise<RuntimeImageRegistry> {
  const candidates = [
    path.resolve(process.cwd(), "deploy/runtime-image-registry.json"),
    path.resolve(process.cwd(), "../../deploy/runtime-image-registry.json"),
  ];
  for (const filePath of candidates) {
    try {
      const file = await readFile(filePath, "utf8");
      return parseRegistry(JSON.parse(file) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`读取运行时镜像注册表失败（${filePath}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error(`找不到运行时镜像注册表；已尝试：${candidates.join("、")}`);
}

async function loadRemoteRuntimeImageRegistry(force = false): Promise<RuntimeImageRegistry | null> {
  const now = Date.now();
  if (!force && remoteRegistryCache && now - remoteRegistryCache.checked_at < RUNTIME_IMAGE_REGISTRY_CACHE_MS) {
    return remoteRegistryCache.registry;
  }
  try {
    const upstream = new URL(OFFICIAL_RUNTIME_IMAGE_REGISTRY_URL);
    if (upstream.protocol !== "https:" || !OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS.has(upstream.hostname)) {
      throw new Error("官方运行时清单地址不在固定 HTTPS 信任边界内");
    }
    const response = await fetch(upstream, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "user-agent": "DeepSonar-Scheduler/1" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== "https:" || !OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS.has(finalUrl.hostname)) {
      throw new Error(`官方运行时清单重定向到非信任主机: ${finalUrl.hostname}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
      throw new Error(`官方运行时清单超过 ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
      throw new Error(`官方运行时清单超过 ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
    }
    const registry = parseRegistry(JSON.parse(text) as unknown);
    remoteRegistryCache = { registry, checked_at: now };
    return registry;
  } catch (error) {
    remoteRegistryCache = { registry: null, checked_at: now };
    console.warn(`[runtime-images] 获取官方最新清单失败，回退内置清单: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function loadRuntimeImageRegistry(options: { refreshRemote?: boolean } = {}): Promise<RuntimeImageRegistry> {
  return (await loadRemoteRuntimeImageRegistry(options.refreshRemote === true)) ?? loadBundledRuntimeImageRegistry();
}

function envOfficialOverrides(): Array<{ image_key: string; image_ref: string }> {
  return [
    ["deepsonar-base", config.images.officialBaseRef],
    ["deepsonar-audit", config.images.officialAuditRef || (immutableDigest(config.runtime.imageAudit) ? config.runtime.imageAudit : "")],
    ["deepsonar-kali-minimal", config.images.officialKaliMinimalRef],
  ].filter((item): item is [string, string] => Boolean(item[1]) && Boolean(immutableDigest(item[1])))
    .map(([image_key, image_ref]) => ({ image_key, image_ref }));
}

export async function runtimeImageRegistryWithOverrides(): Promise<RuntimeImageRegistry> {
  const registry = await loadRuntimeImageRegistry();
  const images = registry.images.map((image) => ({ ...image, versions: [...image.versions] }));
  for (const override of envOfficialOverrides()) {
    const image = images.find((item) => item.image_key === override.image_key);
    if (!image || image.versions.length > 0) continue;
    const digest = immutableDigest(override.image_ref)!;
    if (!image.versions.some((version) => immutableDigest(version.image_ref) === digest)) {
      image.versions.push({ version: `configured-${digest.slice(7, 19)}`, image_ref: override.image_ref, platforms: ["linux/amd64", "linux/arm64"] });
    }
  }
  const trustedVersions = await sql`
    SELECT ri.image_key, ri.name, ri.description, ri.publisher, ri.source_url, ri.project_opt_in,
           v.version, v.image_ref, v.resolved_ref, v.tools_manifest_sha256, v.platforms_json, v.size_bytes
    FROM runtime_images ri
    JOIN runtime_image_versions v ON v.runtime_image_id = ri.id
    WHERE ri.official = true AND v.trust_status = 'trusted'`;
  for (const row of trustedVersions) {
    const imageRef = (row.resolved_ref as string | null) ?? (row.image_ref as string | null);
    const digest = imageRef ? immutableDigest(imageRef) : null;
    if (!digest) continue;
    let image = images.find((item) => item.image_key === row.image_key);
    if (!image) {
      image = {
        image_key: row.image_key as string,
        name: row.name as string,
        description: row.description as string,
        publisher: row.publisher as string,
        source_kind: "official",
        ...(row.source_url ? { source_url: row.source_url as string } : {}),
        project_opt_in: row.project_opt_in === true,
        versions: [],
      };
      images.push(image);
    }
    const sizeBytes = typeof row.size_bytes === "number"
      ? row.size_bytes
      : typeof row.size_bytes === "string" && /^\d+$/.test(row.size_bytes)
        ? Number(row.size_bytes)
        : null;
    const existingVersion = image.versions.find((version) => immutableDigest(version.image_ref) === digest);
    if (!existingVersion) {
      image.versions.push({
        version: row.version as string,
        image_ref: imageRef as string,
        ...(typeof row.tools_manifest_sha256 === "string" ? { tools_manifest_sha256: row.tools_manifest_sha256 } : {}),
        ...(Array.isArray(row.platforms_json) ? { platforms: row.platforms_json as string[] } : {}),
        ...(sizeBytes !== null && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? { size_bytes: sizeBytes } : {}),
      });
    } else {
      if (!existingVersion.tools_manifest_sha256 && typeof row.tools_manifest_sha256 === "string") {
        existingVersion.tools_manifest_sha256 = row.tools_manifest_sha256;
      }
      if ((!existingVersion.platforms || existingVersion.platforms.length === 0) && Array.isArray(row.platforms_json)) {
        existingVersion.platforms = row.platforms_json as string[];
      }
      if (existingVersion.size_bytes === undefined && sizeBytes !== null && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0) {
        existingVersion.size_bytes = sizeBytes;
      }
    }
  }
  return { schema: RUNTIME_IMAGE_REGISTRY_SCHEMA, images };
}

function registryWithEnvOverrides(registry: RuntimeImageRegistry): RuntimeImageRegistry {
  const images = registry.images.map((image) => ({ ...image, versions: [...image.versions] }));
  for (const override of envOfficialOverrides()) {
    const image = images.find((item) => item.image_key === override.image_key);
    if (!image || image.versions.length > 0) continue;
    const digest = immutableDigest(override.image_ref)!;
    if (!image.versions.some((version) => immutableDigest(version.image_ref) === digest)) {
      image.versions.push({ version: `configured-${digest.slice(7, 19)}`, image_ref: override.image_ref, platforms: ["linux/amd64", "linux/arm64"] });
    }
  }
  return { schema: RUNTIME_IMAGE_REGISTRY_SCHEMA, images };
}

export async function syncOfficialRuntimeCatalog(): Promise<RuntimeImageCatalogSyncResult> {
  const registry = registryWithEnvOverrides(await loadRuntimeImageRegistry({ refreshRemote: true }));
  for (const item of registry.images) {
    const [image] = await sql`
      INSERT INTO runtime_images ${sql({
        image_key: item.image_key, name: item.name, description: item.description, publisher: item.publisher,
        source_url: item.source_url ?? null, source_kind: "official", official: true, project_opt_in: item.project_opt_in,
      } as never)}
      ON CONFLICT (image_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        publisher = EXCLUDED.publisher, source_url = EXCLUDED.source_url, official = true,
        project_opt_in = EXCLUDED.project_opt_in, updated_at = now()
      WHERE runtime_images.official = true
      RETURNING id`;
    if (!image) throw new Error(`官方镜像 key 已被非官方产品占用: ${item.image_key}`);
    for (const version of item.versions) {
      const digest = immutableDigest(version.image_ref)!;
      await sql`
        INSERT INTO runtime_image_versions ${sql({
          runtime_image_id: image.id, version: version.version, image_ref: version.image_ref,
          resolved_ref: version.image_ref, digest, contract_version: RUNTIME_IMAGE_CONTRACT,
          platforms_json: (version.platforms ?? []) as never, tools_manifest_sha256: version.tools_manifest_sha256 ?? null,
          size_bytes: version.size_bytes ?? null, scan_summary_json: { source: "static-registry", contract: "declared" } as never,
          trust_status: "trusted", approved_by: "bootstrap", scanned_at: new Date(), approved_at: new Date(), promoted_at: new Date(),
        } as never)}
        ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
          image_ref = EXCLUDED.image_ref, resolved_ref = EXCLUDED.resolved_ref,
          version = EXCLUDED.version,
          platforms_json = CASE WHEN jsonb_array_length(EXCLUDED.platforms_json) > 0
            THEN EXCLUDED.platforms_json ELSE runtime_image_versions.platforms_json END,
          tools_manifest_sha256 = COALESCE(EXCLUDED.tools_manifest_sha256, runtime_image_versions.tools_manifest_sha256),
          size_bytes = COALESCE(EXCLUDED.size_bytes, runtime_image_versions.size_bytes),
          promoted_at = EXCLUDED.promoted_at, updated_at = now()`;
    }
    const promotedDigest = item.versions[0] ? immutableDigest(item.versions[0].image_ref) : null;
    if (promotedDigest) {
      await sql`
        UPDATE runtime_image_versions
        SET promoted_at = NULL, updated_at = now()
        WHERE runtime_image_id = ${image.id} AND digest IS DISTINCT FROM ${promotedDigest}`;
    }
  }
  return {
    registry,
    product_count: registry.images.length,
    version_count: registry.images.reduce((total, image) => total + image.versions.length, 0),
    synced_at: new Date().toISOString(),
  };
}

export function startRuntimeImageRegistrySync(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void syncOfficialRuntimeCatalog()
      .then((result) => console.log(`[runtime-images] 官方清单已自动同步：${result.version_count} 个当前版本`))
      .catch((error) => console.warn(`[runtime-images] 官方清单自动同步失败: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  }, config.images.registrySyncSec * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

export function runtimeImagePullStatus(): RuntimeImagePullTask | null {
  return runtimeImagePullTask;
}

function pullRuntimeImage(imageRef: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["pull", imageRef], { shell: false, stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("docker pull 超时"));
    }, 300_000);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`docker pull exit code ${code ?? "unknown"}`));
    });
  });
}

export async function startRuntimeImagePull(): Promise<RuntimeImagePullTask> {
  if (runtimeImagePullTask && (runtimeImagePullTask.status === "queued" || runtimeImagePullTask.status === "running")) {
    throw new Error("已有运行中的镜像拉取任务");
  }
  const registry = await runtimeImageRegistryWithOverrides();
  const items = registry.images.flatMap((image) => image.versions.map((version) => ({
    image_key: image.image_key,
    image_ref: version.image_ref,
    status: "queued" as const,
    error: null,
  })));
  if (items.length === 0) throw new Error("当前市场清单没有可拉取的不可变版本，请先同步或登记官方 digest");
  const task: RuntimeImagePullTask = {
    task_id: createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24),
    status: "queued", started_at: null, finished_at: null, total: items.length, completed: 0, items,
  };
  runtimeImagePullTask = task;
  void (async () => {
    task.status = "running";
    task.started_at = new Date().toISOString();
    for (const item of task.items) {
      item.status = "running";
      try {
        await pullRuntimeImage(item.image_ref);
        item.status = "succeeded";
      } catch {
        item.status = "failed";
        item.error = "docker pull 失败，请检查 Docker、网络和 registry 凭据";
      }
      task.completed += 1;
    }
    task.status = task.items.some((item) => item.status === "failed") ? "failed" : "succeeded";
    task.finished_at = new Date().toISOString();
  })();
  return task;
}

/** 启动时只接纳管理员显式配置的不可变官方引用；tag 不会被静默信任。 */
export async function bootstrapOfficialRuntimeImages(): Promise<void> {
  // 只迁移从未编辑过的旧 Test 默认值；用户改过（version > 1）的配置保持不动。
  await sql`
    UPDATE role_configs rc SET runtime_image_key = 'deepsonar-kali-minimal', version = version + 1, updated_at = now()
    FROM agent_roles r
    WHERE rc.role_id = r.id AND rc.project_id IS NULL AND rc.version = 1
      AND r.name = 'test' AND rc.runtime_image_key = 'deepsonar-base'`;
  // 非专项角色默认直接使用系统沙箱，不在 RoleConfig 中绑定市场镜像。
  // 只迁移从未编辑过的内置值；项目/用户显式选择保持不动。
  await sql`
    UPDATE role_configs rc SET runtime_image_key = NULL, version = version + 1, updated_at = now()
    FROM agent_roles r
    WHERE rc.role_id = r.id AND rc.project_id IS NULL
      AND r.name = 'verify'
      AND ((rc.version = 1 AND rc.runtime_image_key IN ('deepsonar-base', 'deepsonar-audit', 'deepsonar-kali-minimal'))
        OR (rc.version = 2 AND rc.runtime_image_key IN ('deepsonar-base', 'deepsonar-kali-minimal')))`;
  await sql`
    UPDATE role_configs rc SET runtime_image_key = NULL, version = version + 1, updated_at = now()
    FROM agent_roles r
    WHERE rc.role_id = r.id AND rc.project_id IS NULL AND rc.version = 1
      AND r.name IN ('explore', 'analyze', 'review', 'code', 'hub_reason', 'report')
      AND rc.runtime_image_key = 'deepsonar-base'`;
  await sql`
    UPDATE agent_roles SET
      description = '系统角色：默认在最小基础环境中验证 Finding，给出 confirmed、false_positive 或 needs_human 结论；需要专项工具时可由 RoleConfig 覆盖镜像；Hub 不可下发',
      updated_at = now()
    WHERE name = 'verify' AND builtin = true AND kind = 'system'
      AND description = '系统角色：默认在精简 Kali 多语言环境中验证 Finding，给出 confirmed、false_positive 或 needs_human 结论；Hub 不可下发'`;
  await syncOfficialRuntimeCatalog();
}

/**
 * 创建 Job 时选择一次并冻结；Executor 不再读取目录或 tag。
 * 未绑定市场镜像时使用平台治理的最小 Base 作为系统沙箱底座，而不是允许 Agent 指定引用。
 */
export async function resolveRuntimeImageForJob(
  db: typeof sql,
  projectId: string,
  roleName: string,
  configuredKey: string | null,
): Promise<RuntimeImageSnapshot> {
  const imageKey = configuredKey || (
    roleName === "test"
      ? "deepsonar-kali-minimal"
      : roleName === "audit" ? "deepsonar-audit" : "deepsonar-base"
  );
  const [row] = await db`
    SELECT ri.id AS runtime_image_id, ri.image_key, ri.source_kind, ri.official,
           riv.id AS runtime_image_version_id, riv.resolved_ref, riv.digest,
           riv.tools_manifest_sha256, riv.contract_version,
           scan.id AS admission_scan_id
    FROM runtime_images ri
    LEFT JOIN project_runtime_images pri
      ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
    JOIN LATERAL (
      SELECT v.* FROM runtime_image_versions v
      WHERE v.runtime_image_id = ri.id
        AND v.trust_status = 'trusted'
        AND (pri.selected_version_id IS NULL OR v.id = pri.selected_version_id)
      ORDER BY v.promoted_at DESC NULLS LAST, v.approved_at DESC NULLS LAST, v.created_at DESC
      LIMIT 1
    ) riv ON true
    LEFT JOIN LATERAL (
      SELECT s.id FROM runtime_image_scans s
      WHERE s.runtime_image_version_id = riv.id AND s.status = 'succeeded'
      ORDER BY s.finished_at DESC NULLS LAST LIMIT 1
    ) scan ON true
    WHERE ri.image_key = ${imageKey}
      AND ri.enabled = true
      AND (CASE WHEN ri.official AND NOT ri.project_opt_in THEN COALESCE(pri.enabled, true) ELSE COALESCE(pri.enabled, false) END)`;

  if (!row) {
    if (config.runtime.agentMode === "fake") return fakeSnapshot(imageKey);
    throw new Error(`角色 ${roleName} 没有可用的可信运行镜像版本（key=${imageKey}）；请先准入 digest 并为项目启用`);
  }
  const resolvedRef = row.resolved_ref as string | null;
  const digest = row.digest as string | null;
  const resolvedDigest = resolvedRef ? (immutableDigest(resolvedRef) ?? localImageDigest(resolvedRef)) : null;
  if (!resolvedRef || !digest || resolvedDigest !== digest) {
    throw new Error(`可信镜像版本缺少一致的不可变引用（key=${imageKey}）`);
  }
  return {
    runtime_image_id: row.runtime_image_id as string,
    runtime_image_version_id: row.runtime_image_version_id as string,
    image_key: row.image_key as string,
    image_ref: resolvedRef,
    image_digest: digest,
    tools_manifest_sha256: (row.tools_manifest_sha256 as string | null) ?? null,
    admission_scan_id: (row.admission_scan_id as string | null) ?? null,
    contract_version: row.contract_version as string,
    source_kind: row.source_kind as "official" | "third_party",
    trust_status: "trusted",
  };
}
