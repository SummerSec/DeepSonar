/**
 * 项目导出：收集模块 → .deepsonarpack
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { validateModuleSelectors } from "@deepsonar/shared-types";
import { sql } from "../db.js";
import {
  projectCredentialMetadata,
  projectCredentialProvider,
  projectCredentialProviderError,
  projectJobEventPayload,
  projectJobPayload,
} from "../credentials.js";
import {
  buildManifestSource,
  ensureTransferDirs,
  toJsonl,
  transferRoot,
  writeDeepsonarPack,
  type Manifest,
  type PackFile,
} from "./pack.js";
import { FORMAT, FORMAT_VERSION, moduleVersion, resolveModules, type ModuleKey, type Preset } from "./modules.js";
import { ACTIVE_JOB_STATUSES, filterEnvVars, sanitizeAgentSnapshot } from "./sanitize.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface ExportOptions {
  preset: Preset;
  modules?: string[];
  include_blobs?: boolean;
  credentials?: { mode?: "excluded" | "metadata" };
  /** 允许在有活动 Job 时仍导出完整任务（归档模式） */
  allow_active_jobs?: boolean;
}

export interface ProjectManifestOptions {
  projectId: string;
  projectName: string;
  preset: Preset;
  modules: ModuleKey[];
  counts: Record<string, number>;
  credentialsMode: "excluded" | "metadata";
  instanceId: string;
}

/** Build the project export manifest with the current Scheduler schema baseline. */
export function buildProjectManifest(options: ProjectManifestOptions): Manifest {
  return {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    created_at: new Date().toISOString(),
    source: buildManifestSource({
      app_version: "0.0.1",
      instance_id: `sha256:${options.instanceId.slice(0, 16)}`,
      project_id: options.projectId,
      project_name: options.projectName,
    }),
    preset: options.preset,
    modules: options.modules,
    counts: options.counts,
    compatibility: {
      minimum_importer_version: "1.0",
      module_versions: Object.fromEntries(options.modules.map((m) => [m, moduleVersion(m)])),
    },
    secrets: { mode: options.credentialsMode === "excluded" ? "excluded" : "metadata", algorithm: null },
    signature: null,
  };
}

export async function runExport(exportId: string): Promise<void> {
  const [row] = await sql`SELECT * FROM data_exports WHERE id = ${exportId}`;
  if (!row || row.status === "cancelled") return;
  if ((row.scope as string) === "platform") return; // 由 platform.ts 处理

  const claim = await sql`
    UPDATE data_exports SET status = 'collecting', started_at = coalesce(started_at, now()),
      claimed_at = now(), heartbeat_at = now(), attempts = attempts + 1
    WHERE id = ${exportId} AND status IN ('pending','collecting')
    RETURNING *`;
  if (!claim[0]) return;

  const projectId = claim[0].project_id as string;
  const options = (claim[0].options_json ?? {}) as ExportOptions;
  const preset = (claim[0].preset as Preset) || options.preset || "configuration";
  const { modules } = resolveModules(preset, (claim[0].modules_json as string[]) ?? options.modules);

  try {
    const [project] = await sql`SELECT * FROM projects WHERE id = ${projectId}`;
    if (!project) throw Object.assign(new Error("project not found"), { code: "PROJECT_NOT_FOUND" });

    const hasTasks = modules.includes("tasks") || modules.includes("findings") || modules.includes("events");
    if (hasTasks && !options.allow_active_jobs) {
      const active = await sql`
        SELECT COUNT(*)::int AS n FROM jobs
        WHERE project_id = ${projectId} AND status = ANY(${ACTIVE_JOB_STATUSES as unknown as string[]})`;
      if ((active[0]?.n as number) > 0) {
        throw Object.assign(
          new Error(`项目存在 ${(active[0] as { n: number }).n} 个活动 Job，请等待结束、取消任务或仅导出配置`),
          { code: "ACTIVE_JOBS" },
        );
      }
    }

    await sql`UPDATE data_exports SET status = 'packaging', heartbeat_at = now() WHERE id = ${exportId}`;

    const files: PackFile[] = [];
    const counts: Record<string, number> = {};
    const credMode = options.credentials?.mode ?? "metadata";

    // project
    files.push({
      path: "data/project.json",
      content: JSON.stringify(
        {
          source_id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          // 外部集成标识默认不迁移为可用绑定
          plane_project_id: null,
          config_json: stripConfigSecrets(project.config_json),
        },
        null,
        2,
      ),
    });
    counts.project = 1;

    if (modules.includes("rules")) {
      const rules = ((project.config_json as Record<string, unknown>)?.rules ?? {}) as Record<string, unknown>;
      files.push({ path: "data/rules.json", content: JSON.stringify({ rules }, null, 2) });
      counts.rules = 1;
    }

    if (modules.includes("roles") || modules.includes("environment") || modules.includes("skills") || modules.includes("runtime_images")) {
      await collectRoles(projectId, modules, files, counts, credMode);
    }

    if (modules.includes("integrations")) {
      const cfg = (project.config_json ?? {}) as Record<string, unknown>;
      files.push({
        path: "data/integrations.json",
        content: JSON.stringify(
          {
            plane: cfg.plane
              ? { present: true, enabled: false, note: "导入后需在目标环境重新绑定" }
              : null,
          },
          null,
          2,
        ),
      });
      counts.integrations = 1;
    }

    if (modules.includes("tasks") || modules.includes("findings") || modules.includes("events") || modules.includes("artifacts")) {
      await collectTasks(projectId, modules, files, counts);
    }

    if (modules.includes("audit_archive")) {
      const logs = await sql`
        SELECT at, actor_type, actor_id, action, resource_type, resource_id, result, error_code, after_json
        FROM audit_logs WHERE project_id = ${projectId} ORDER BY at LIMIT 5000`;
      // 脱敏：不导出 ip/user_agent
      files.push({ path: "evidence/audit-logs.jsonl", content: toJsonl(logs) });
      counts.audit_logs = logs.length;
    }

    const instanceId = sha256Hex(`deepsonar:${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "local"}`);
    const manifest = buildProjectManifest({
      projectId,
      projectName: project.name as string,
      preset,
      modules,
      counts,
      credentialsMode: credMode,
      instanceId,
    });

    await ensureTransferDirs();
    const outPath = path.join(transferRoot(), "exports", `${exportId}.deepsonarpack`);
    const { sha256, size } = await writeDeepsonarPack(files, manifest, outPath);
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000);

    await sql`
      UPDATE data_exports SET
        status = 'succeeded',
        artifact_uri = ${outPath},
        artifact_sha256 = ${sha256},
        artifact_size = ${size},
        expires_at = ${expires},
        finished_at = now(),
        heartbeat_at = now(),
        error = null,
        error_code = null
      WHERE id = ${exportId}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "EXPORT_FAILED";
    await sql`
      UPDATE data_exports SET status = 'failed', error = ${msg}, error_code = ${code},
        finished_at = now(), heartbeat_at = now()
      WHERE id = ${exportId}`;
  }
}

function stripConfigSecrets(configJson: unknown): Record<string, unknown> {
  if (!configJson || typeof configJson !== "object") return {};
  const cfg = { ...(configJson as Record<string, unknown>) };
  // plane 绑定 id 不导出为可用
  if (cfg.plane && typeof cfg.plane === "object") {
    cfg.plane = { ...(cfg.plane as object), note: "rebind_required" };
  }
  return cfg;
}

async function collectRoles(
  projectId: string,
  modules: ModuleKey[],
  files: PackFile[],
  counts: Record<string, number>,
  credMode: "excluded" | "metadata",
) {
  const enabled = await sql`
    SELECT config_json FROM projects WHERE id = ${projectId}`;
  const rolesCfg = (((enabled[0]?.config_json as Record<string, unknown>)?.roles ?? {}) ?? {}) as Record<
    string,
    unknown
  >;

  const roleRows = await sql`
    SELECT r.id, r.name, r.title, r.description, r.builtin, r.kind, r.ui_color
    FROM agent_roles r
    WHERE r.kind = 'role' OR r.name IN (
      SELECT ar.name FROM agent_roles ar
      JOIN role_configs rc ON rc.role_id = ar.id AND rc.project_id = ${projectId}
    )`;
  files.push({ path: "data/roles.jsonl", content: toJsonl(roleRows) });
  counts.roles = roleRows.length;

  const configs = await sql`
    SELECT rc.*, ar.name AS role_name
    FROM role_configs rc
    JOIN agent_roles ar ON ar.id = rc.role_id
    WHERE rc.project_id = ${projectId}`;

  const configOut = [];
  const envKeysAll = new Set<string>();
  const envSafeAll: Record<string, string> = {};
  const redactedAll = new Set<string>();
  const skillRefs: unknown[] = [];
  const imageRefs: unknown[] = [];
  const credMeta: unknown[] = [];
  const credSeen = new Set<string>();

  for (const rc of configs) {
    const moduleSelectors = rc.modules_json == null
      ? []
      : validateModuleSelectors(rc.modules_json, `RoleConfig ${String(rc.role_name)}.modules_json`);
    const { safe, redacted_keys } = filterEnvVars(rc.env_vars_json as Record<string, unknown>);
    for (const k of (rc.env_keys as string[]) ?? []) envKeysAll.add(k);
    Object.assign(envSafeAll, safe);
    redacted_keys.forEach((k) => redactedAll.add(k));

    if (modules.includes("skills") && Array.isArray(rc.modules_json)) {
      skillRefs.push({
        role_name: rc.role_name,
        modules: moduleSelectors,
        skill_revisions_note: "content resolved on target via skill-sources sync",
      });
    }
    // 项目 RoleConfig 的 runtime_image_key 是遗留字段，不进入项目镜像策略导出。

    const filesRows = await sql`
      SELECT path, content, content_sha256 FROM role_config_files WHERE role_config_id = ${rc.id as string}`;
    const binds = await sql`
      SELECT c.id, c.name, c.kind, c.provider, c.fingerprint, c.last4, c.public_metadata_json, rc2.purpose
      FROM role_credentials rc2
      JOIN credentials c ON c.id = rc2.credential_id
      WHERE rc2.role_config_id = ${rc.id as string}`;

    for (const b of binds) {
      if (credMode === "excluded") continue;
      if (credSeen.has(b.id as string)) continue;
      credSeen.add(b.id as string);
      const providerProjection = projectCredentialProvider(b.kind, b.provider);
      credMeta.push({
        source_id: b.id,
        name: b.name,
        kind: b.kind,
        ...providerProjection,
        fingerprint: b.fingerprint,
        last4: b.last4,
        public_metadata: projectCredentialMetadata(String(b.kind), String(b.provider), b.public_metadata_json),
        secret_included: false,
      });
    }

    configOut.push({
      source_id: rc.id,
      role_name: rc.role_name,
      agent_cli: rc.agent_cli,
      dsh_task_mode: rc.dsh_task_mode,
      model: rc.model,
      context_window_tokens: rc.context_window_tokens == null ? null : Number(rc.context_window_tokens),
      env_keys: rc.env_keys,
      env_vars: safe,
      env_vars_redacted: redacted_keys,
      modules_json: moduleSelectors,
      skills_json: rc.skills_json,
      commands_json: rc.commands_json,
      mcps_json: rc.mcps_json,
      subagents_json: rc.subagents_json,
      platform_tools_json: rc.platform_tools_json,
      sandbox_limits_json: rc.sandbox_limits_json,
      runtime_knobs_json: rc.runtime_knobs_json,
      pi_extensions_json: rc.pi_extensions_json ?? [],
      // 项目镜像仅由 projects.config_json.image_strategy/role_runtime_images 管理。
      runtime_image_key: null,
      version: rc.version,
      files: filesRows,
      credentials: binds.map((b) => ({
        source_credential_id: b.id,
        purpose: b.purpose,
        name: b.name,
        ...projectCredentialProvider(b.kind, b.provider),
      })),
    });
  }

  files.push({ path: "data/role-configs.jsonl", content: toJsonl(configOut) });
  counts.role_configs = configOut.length;

  files.push({
    path: "data/roles-enabled.json",
    content: JSON.stringify({ enabled: rolesCfg.enabled ?? null }, null, 2),
  });

  if (modules.includes("environment")) {
    files.push({
      path: "data/environment.json",
      content: JSON.stringify(
        {
          env_keys: [...envKeysAll],
          env_vars: envSafeAll,
          redacted_keys: [...redactedAll],
          note: "Secret 值未导出；redacted_keys / env_keys 需在目标环境配置或映射 Credential",
        },
        null,
        2,
      ),
    });
    counts.environment = 1;
  }

  if (modules.includes("skills")) {
    // 引用 skill_sources 元数据（不含 catalog 全文大字段可截断）
    const sources = await sql`
      SELECT id, name, repo_url, branch, trust_status, enabled FROM skill_sources`;
    files.push({
      path: "data/skills.jsonl",
      content: toJsonl(
        sources.map((s) => ({
          ...s,
          trust_status_export: "quarantined",
          note: "导入后保持 quarantined，需目标环境重新审批",
          role_bindings: skillRefs.filter(Boolean),
        })),
      ),
    });
    counts.skills = sources.length;
  }

  if (modules.includes("runtime_images")) {
    files.push({ path: "data/runtime-images.jsonl", content: toJsonl(imageRefs) });
    counts.runtime_images = imageRefs.length;
  }

  if (modules.includes("credentials") && credMode !== "excluded") {
    files.push({ path: "data/credentials.jsonl", content: toJsonl(credMeta) });
    counts.credentials = credMeta.length;
  }
}

async function collectTasks(
  projectId: string,
  modules: ModuleKey[],
  files: PackFile[],
  counts: Record<string, number>,
) {
  const canvases = await sql`SELECT * FROM canvases WHERE project_id = ${projectId} ORDER BY created_at`;
  files.push({
    path: "data/canvases.jsonl",
    content: toJsonl(
      canvases.map((c) => ({
        source_id: c.id,
        title: c.title,
        target_json: c.target_json,
        plane_issue_id: null,
        trigger_source: c.trigger_source,
        trigger_event_id: null,
        trigger_payload_json: {},
        created_at: c.created_at,
      })),
    ),
  });
  counts.canvases = canvases.length;

  const jobs = await sql`SELECT * FROM jobs WHERE project_id = ${projectId} ORDER BY created_at`;
  files.push({
    path: "data/jobs.jsonl",
    content: toJsonl(
      jobs.map((j) => ({
        source_id: j.id,
        source_canvas_id: j.canvas_id,
        source_parent_job_id: j.parent_job_id,
        source_finding_id: j.finding_id,
        type: j.type,
        status: j.status,
        priority: j.priority,
        payload_json: projectJobPayload(j.payload_json),
        agent_snapshot_json: sanitizeAgentSnapshot(j.agent_snapshot_json),
        timeout_sec: j.timeout_sec,
        followup_depth: j.followup_depth,
        transcript_uri: j.transcript_uri,
        error: projectCredentialProviderError(j.error),
        started_at: j.started_at,
        finished_at: j.finished_at,
        created_at: j.created_at,
        // 运行态不导出
        sandbox_id: null,
        lease_expires_at: null,
        heartbeat_at: null,
        claimed_at: null,
      })),
    ),
  });
  counts.jobs = jobs.length;

  if (canvases.length) {
    const canvasIds = canvases.map((c) => c.id as string);
    const nodes = await sql`SELECT * FROM canvas_nodes WHERE canvas_id = ANY(${canvasIds}) ORDER BY created_at`;
    files.push({
      path: "data/nodes.jsonl",
      content: toJsonl(
        nodes.map((n) => ({
          source_id: n.id,
          source_canvas_id: n.canvas_id,
          source_job_id: n.job_id,
          node_type: n.node_type,
          title: n.title,
          body_json: n.body_json,
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
          status: n.status,
          verification_status: n.verification_status,
        })),
      ),
    });
    counts.nodes = nodes.length;

    const edges = await sql`SELECT * FROM canvas_edges WHERE canvas_id = ANY(${canvasIds}) ORDER BY created_at`;
    files.push({
      path: "data/edges.jsonl",
      content: toJsonl(
        edges.map((e) => ({
          source_id: e.id,
          source_canvas_id: e.canvas_id,
          source_from_node_id: e.from_node_id,
          source_to_node_id: e.to_node_id,
          edge_type: e.edge_type,
        })),
      ),
    });
    counts.edges = edges.length;
  }

  if (modules.includes("findings")) {
    const findings = await sql`SELECT * FROM findings WHERE project_id = ${projectId} ORDER BY created_at`;
    files.push({
      path: "data/findings.jsonl",
      content: toJsonl(
        findings.map((f) => ({
          source_id: f.id,
          source_job_id: f.job_id,
          source_node_id: f.node_id,
          fingerprint: f.fingerprint,
          title: f.title,
          severity: f.severity,
          location: f.location,
          summary: f.summary,
          suggest_verify: f.suggest_verify,
          verify_status: f.verify_status,
          raw_json: f.raw_json,
          created_at: f.created_at,
        })),
      ),
    });
    counts.findings = findings.length;
  }

  if (modules.includes("events") && jobs.length) {
    const jobIds = jobs.map((j) => j.id as string);
    // 限制事件量
    const events = await sql`
      SELECT job_id, event_id, job_seq, type, payload_json, created_at
      FROM events WHERE job_id = ANY(${jobIds})
      ORDER BY id LIMIT 100000`;
    files.push({
      path: "data/events.jsonl",
      content: toJsonl(
        events.map((e) => ({
          source_job_id: e.job_id,
          event_id: e.event_id,
          job_seq: e.job_seq,
          type: e.type,
          payload_json: projectJobEventPayload(e.payload_json),
          created_at: e.created_at,
        })),
      ),
    });
    counts.events = events.length;
  }
}
