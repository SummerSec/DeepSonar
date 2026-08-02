import { createHash } from "node:crypto";
import { config } from "./config.js";
import { sql } from "./db.js";

export const RUNTIME_IMAGE_CONTRACT = "deepsonar.runtime.contract/v1";

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
  const match = imageRef.trim().match(/(?:@|^)(sha256:[0-9a-f]{64})$/);
  return match?.[1] ?? null;
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

/** 启动时只接纳管理员显式配置的不可变官方引用；tag 不会被静默信任。 */
export async function bootstrapOfficialRuntimeImages(): Promise<void> {
  // 只迁移从未编辑过的旧 Test 默认值；用户改过（version > 1）的配置保持不动。
  await sql`
    UPDATE role_configs rc SET runtime_image_key = 'deepsonar-kali-minimal', version = version + 1, updated_at = now()
    FROM agent_roles r
    WHERE rc.role_id = r.id AND rc.project_id IS NULL AND rc.version = 1
      AND r.name = 'test' AND rc.runtime_image_key = 'deepsonar-base'`;
  // 历史默认是 Audit；上一版又曾把未编辑的 Verify 默认迁到 Kali（version=2）。这些内置默认统一迁到 Base。
  await sql`
    UPDATE role_configs rc SET runtime_image_key = 'deepsonar-base', version = version + 1, updated_at = now()
    FROM agent_roles r
    WHERE rc.role_id = r.id AND rc.project_id IS NULL
      AND r.name = 'verify'
      AND ((rc.version = 1 AND rc.runtime_image_key IN ('deepsonar-audit', 'deepsonar-kali-minimal'))
        OR (rc.version = 2 AND rc.runtime_image_key = 'deepsonar-kali-minimal'))`;
  await sql`
    UPDATE agent_roles SET
      description = '系统角色：默认在最小基础环境中验证 Finding，给出 confirmed、false_positive 或 needs_human 结论；需要专项工具时可由 RoleConfig 覆盖镜像；Hub 不可下发',
      updated_at = now()
    WHERE name = 'verify' AND builtin = true AND kind = 'system'
      AND description = '系统角色：默认在精简 Kali 多语言环境中验证 Finding，给出 confirmed、false_positive 或 needs_human 结论；Hub 不可下发'`;
  // 官方产品元数据由代码维护；同步全部条目，修复已有数据库里遗留的旧角色描述。
  await sql`
    UPDATE runtime_images ri SET
      name = canonical.name,
      description = canonical.description,
      project_opt_in = false,
      updated_at = now()
    FROM (VALUES
      ('deepsonar-base', 'DeepSonar Base', 'Explore、Analyze、Code、Hub 与 Verify 的官方最小运行时'),
      ('deepsonar-audit', 'DeepSonar Audit', 'Audit 的官方审计运行时'),
      ('deepsonar-kali-minimal', 'DeepSonar Kali Test', 'Test 默认使用的精简 Kali 多语言工具链；不安装 Kali metapackage 或 GUI')
    ) AS canonical(image_key, name, description)
    WHERE ri.image_key = canonical.image_key AND ri.official = true
      AND (ri.name, ri.description, ri.project_opt_in)
          IS DISTINCT FROM (canonical.name, canonical.description, false)`;

  const configured = [
    { key: "deepsonar-base", ref: config.images.officialBaseRef },
    { key: "deepsonar-audit", ref: config.images.officialAuditRef || (immutableDigest(config.runtime.imageAudit) ? config.runtime.imageAudit : "") },
    { key: "deepsonar-kali-minimal", ref: config.images.officialKaliMinimalRef },
  ];
  for (const item of configured) {
    if (!item.ref) continue;
    const digest = immutableDigest(item.ref);
    if (!digest) {
      console.warn(`[runtime-images] 忽略可移动官方 tag：${item.key}=${item.ref}；请配置 @sha256 digest`);
      continue;
    }
    const [image] = await sql`SELECT id FROM runtime_images WHERE image_key = ${item.key} AND official = true`;
    if (!image) throw new Error(`缺少官方 runtime_images 基线: ${item.key}`);
    await sql`
      INSERT INTO runtime_image_versions ${sql({
        runtime_image_id: image.id,
        version: `configured-${digest.slice(7, 19)}`,
        image_ref: item.ref,
        resolved_ref: item.ref,
        digest,
        contract_version: RUNTIME_IMAGE_CONTRACT,
        platforms_json: ["linux/amd64", "linux/arm64"] as never,
        scan_summary_json: { source: "operator-configured-official", contract: "declared" } as never,
        trust_status: "trusted",
        approved_by: "bootstrap",
        scanned_at: new Date(),
        approved_at: new Date(),
        promoted_at: new Date(),
      } as never)}
      ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
        image_ref = EXCLUDED.image_ref,
        resolved_ref = EXCLUDED.resolved_ref,
        promoted_at = EXCLUDED.promoted_at,
        updated_at = now()`;
  }
}

/** 创建 Job 时选择一次并冻结；Executor 不再读取目录或 tag。 */
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
  if (!resolvedRef || !digest || immutableDigest(resolvedRef) !== digest) {
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
