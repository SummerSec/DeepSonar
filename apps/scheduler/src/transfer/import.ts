/**
 * 项目导入：预览 + create_new / merge_configuration
 */
import { randomUUID } from "node:crypto";
import { FactVerificationStatus, validateModuleSelectors, validatePiExtensionIds } from "@deepsonar/shared-types";
import {
  projectCredentialMetadata,
  projectCredentialProvider,
  validateCredentialRoleConfigBinding,
} from "../credentials.js";
import { DISPATCH_CLAIM_ADVISORY_KEY } from "../core.js";
import { sql } from "../db.js";
import { freezeAgentSnapshotNetworkPolicy } from "../domains/role-runtime-snapshot/index.js";
import {
  parseProjectImagePolicy,
  persistableProjectRoleConfigModel,
  type ProjectImagePolicy,
} from "../domains/role-runtime-snapshot/application.js";
import { parseSandboxLimitsOverride } from "../domains/role-runtime-snapshot/sandbox-limits.js";
import { parseRuntimeKnobOverride } from "../runtime-knobs.js";
import {
  loadPackFile,
  openDeepsonarPack,
  readJson,
  readJsonl,
  type Manifest,
  type OpenedPack,
} from "./pack.js";
import { CONFIG_MODULES, isConfigOnly, type ModuleKey } from "./modules.js";
import { archiveJobStatus, parseTransferredDshTaskMode } from "./sanitize.js";

export interface PreviewResult {
  compatible: boolean;
  source: Manifest["source"];
  selected_modules: ModuleKey[];
  auto_added_dependencies: string[];
  counts: Record<string, number>;
  conflicts: { module: string; key: string; message: string }[];
  warnings: string[];
  credential_mappings_required: { source_id: string; name: string; provider: string; provider_valid?: boolean }[];
  environment_keys_required: string[];
  nonportable_paths: string[];
  disabled_integrations: string[];
  estimated_database_bytes: number;
  estimated_blob_bytes: number;
}

export async function buildPreview(importId: string): Promise<PreviewResult> {
  const [row] = await sql`SELECT * FROM data_imports WHERE id = ${importId}`;
  if (!row) throw Object.assign(new Error("import not found"), { code: "NOT_FOUND" });

  await sql`UPDATE data_imports SET status = 'validating', started_at = coalesce(started_at, now()) WHERE id = ${importId}`;

  const buf = await loadPackFile(row.source_artifact_uri as string);
  const pack = await openDeepsonarPack(buf);
  const modules = (row.selected_modules_json as ModuleKey[])?.length
    ? (row.selected_modules_json as ModuleKey[])
    : pack.manifest.modules;

  const warnings: string[] = [];
  const conflicts: PreviewResult["conflicts"] = [];
  const creds = readJsonl(pack.files, "data/credentials.jsonl");
  const env = readJson<{ env_keys?: string[]; redacted_keys?: string[] }>(pack.files, "data/environment.json");
  const project = readJson<{ name?: string }>(pack.files, "data/project.json");

  if (project?.name) {
    const [dup] = await sql`SELECT id FROM projects WHERE name = ${project.name} LIMIT 1`;
    if (dup) {
      conflicts.push({
        module: "project",
        key: project.name,
        message: "同名项目已存在，create_new 将自动追加后缀",
      });
    }
  }

  for (const m of modules) {
    if (!CONFIG_MODULES.has(m) && m !== "tasks" && m !== "findings" && m !== "events" && m !== "artifacts" && m !== "audit_archive") {
      warnings.push(`模块 ${m} 当前版本支持有限，可能被跳过`);
    }
  }

  warnings.push("导入默认创建新项目并重映射 ID；外部集成与 Credential 需在目标环境重新绑定");
  if (modules.includes("tasks")) {
    warnings.push("活动 Job 将归档为 cancelled，不会自动继续执行");
  }

  // Credential metadata in an old package is untrusted input.  It is not
  // imported as a secret, but still sanitize it before any preview/manifest
  // projection and make lossy cleanup visible to the operator.
  let sanitizedCredentialMetadata = 0;
  for (const credential of creds) {
    const safe = projectCredentialMetadata(String(credential.kind ?? ""), String(credential.provider ?? ""), credential.public_metadata);
    if (JSON.stringify(safe) !== JSON.stringify(credential.public_metadata ?? {})) sanitizedCredentialMetadata += 1;
  }
  if (sanitizedCredentialMetadata > 0) {
    warnings.push(`已清理 ${sanitizedCredentialMetadata} 条 Credential 的不安全 legacy metadata；不会原样写入目标库`);
  }

  const preview: PreviewResult = {
    compatible: true,
    source: pack.manifest.source,
    selected_modules: modules,
    auto_added_dependencies: [],
    counts: pack.manifest.counts ?? {},
    conflicts,
    warnings,
    credential_mappings_required: creds.map((c) => {
      const provider = typeof c.provider === "string" ? c.provider : "";
      return {
        source_id: String(c.source_id),
        name: String(c.name ?? ""),
        ...(provider === ""
          ? { provider, provider_valid: false }
          : projectCredentialProvider(c.kind, provider)),
      };
    }),
    environment_keys_required: [
      ...new Set([...(env?.env_keys ?? []), ...(env?.redacted_keys ?? [])]),
    ],
    nonportable_paths: [],
    disabled_integrations: [],
    estimated_database_bytes: buf.length,
    estimated_blob_bytes: 0,
  };

  await sql`
    UPDATE data_imports SET
      status = 'preview_ready',
      source_manifest_json = ${sql.json(pack.manifest as never)},
      preview_json = ${sql.json(preview as never)},
      selected_modules_json = ${sql.json(modules as never)},
      heartbeat_at = now()
    WHERE id = ${importId}`;

  return preview;
}

export interface ApplyBody {
  mode: "create_new" | "merge_configuration";
  project_name?: string;
  target_project_id?: string;
  modules?: ModuleKey[];
  conflict_policy?: "rename" | "keep_target" | "use_source";
  credential_mappings?: Record<string, string>;
}

export async function applyImport(importId: string, body: ApplyBody): Promise<{ project_id: string; id_map: Record<string, unknown> }> {
  const [row] = await sql`SELECT * FROM data_imports WHERE id = ${importId}`;
  if (!row) throw Object.assign(new Error("import not found"), { code: "NOT_FOUND" });
  if (row.status === "succeeded") {
    return {
      project_id: row.target_project_id as string,
      id_map: (row.id_map_json as Record<string, unknown>) ?? {},
    };
  }
  if (!["preview_ready", "uploaded", "failed"].includes(row.status as string)) {
    throw Object.assign(new Error(`import status ${row.status} cannot apply`), { code: "BAD_STATUS" });
  }

  const claim = await sql`
    UPDATE data_imports SET status = 'applying', started_at = coalesce(started_at, now()),
      claimed_at = now(), heartbeat_at = now(), attempts = attempts + 1,
      mode = ${body.mode}
    WHERE id = ${importId} AND status IN ('preview_ready','uploaded','failed')
    RETURNING *`;
  if (!claim[0]) throw Object.assign(new Error("failed to claim import"), { code: "CLAIM_FAILED" });

  try {
    const buf = await loadPackFile(row.source_artifact_uri as string);
    const pack = await openDeepsonarPack(buf);
    const modules = body.modules?.length
      ? body.modules
      : ((row.selected_modules_json as ModuleKey[])?.length
          ? (row.selected_modules_json as ModuleKey[])
          : pack.manifest.modules);

    if (body.mode === "merge_configuration") {
      if (!body.target_project_id) {
        throw Object.assign(new Error("merge_configuration requires target_project_id"), { code: "NO_TARGET" });
      }
      if (!isConfigOnly(modules)) {
        throw Object.assign(new Error("merge_configuration 仅允许配置类模块"), { code: "MODULES_NOT_CONFIG" });
      }
      const idMap = await mergeConfiguration(body.target_project_id, pack, modules, body);
      await sql`
        UPDATE data_imports SET status = 'succeeded', target_project_id = ${body.target_project_id},
          id_map_json = ${sql.json(idMap as never)}, finished_at = now(), error = null
        WHERE id = ${importId}`;
      return { project_id: body.target_project_id, id_map: idMap };
    }

    // create_new
    const result = await createNewProject(pack, modules, body);
    await sql`
      UPDATE data_imports SET status = 'succeeded', target_project_id = ${result.project_id},
        id_map_json = ${sql.json(result.id_map as never)}, finished_at = now(), error = null
      WHERE id = ${importId}`;
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "APPLY_FAILED";
    await sql`
      UPDATE data_imports SET status = 'failed', error = ${msg}, error_code = ${code}, finished_at = now()
      WHERE id = ${importId}`;
    throw e;
  }
}

async function createNewProject(
  pack: OpenedPack,
  modules: ModuleKey[],
  body: ApplyBody,
): Promise<{ project_id: string; id_map: Record<string, unknown> }> {
  const srcProject = readJson<{
    name?: string;
    description?: string;
    config_json?: Record<string, unknown>;
  }>(pack.files, "data/project.json");
  if (!srcProject) throw Object.assign(new Error("data/project.json missing"), { code: "NO_PROJECT" });

  let name = body.project_name?.trim() || srcProject.name || "Imported Project";
  const [dup] = await sql`SELECT id FROM projects WHERE name = ${name} LIMIT 1`;
  if (dup) name = `${name}-import-${randomUUID().slice(0, 8)}`;

  const rulesFile = readJson<{ rules?: Record<string, unknown> }>(pack.files, "data/rules.json");
  const enabledFile = readJson<{ enabled?: string[] | null }>(pack.files, "data/roles-enabled.json");
  const config_json: Record<string, unknown> = {
    ...(srcProject.config_json ?? {}),
  };
  if (modules.includes("rules") && rulesFile?.rules) {
    config_json.rules = rulesFile.rules;
  }
  if (modules.includes("roles") && enabledFile) {
    config_json.roles = { enabled: enabledFile.enabled ?? null };
  }

  const id_map: {
    projects: Record<string, string>;
    canvases: Record<string, string>;
    jobs: Record<string, string>;
    nodes: Record<string, string>;
    findings: Record<string, string>;
    role_configs: Record<string, string>;
    credentials: Record<string, string>;
  } = {
    projects: {},
    canvases: {},
    jobs: {},
    nodes: {},
    findings: {},
    role_configs: {},
    credentials: { ...(body.credential_mappings ?? {}) },
  };

  return await sql.begin(async (tx) => {
    const [project] = await tx`
      INSERT INTO projects ${tx({
        name,
        description: (srcProject.description ?? "") + "\n\n[imported from deepsonarpack]",
        config_json: config_json as never,
      })}
      RETURNING id`;
    const projectId = project.id as string;
    id_map.projects[pack.manifest.source.project_id] = projectId;

    if (modules.includes("roles") || modules.includes("environment")) {
      await importRoleConfigs(tx as Tx, projectId, pack, id_map, false, parseProjectImagePolicy(config_json));
    }

    if (modules.includes("tasks") || modules.includes("findings") || modules.includes("events")) {
      await importTasks(tx as Tx, projectId, pack, modules, id_map);
    }

    // 来源审计只作为 provenance，不写入 audit_logs 业务行（由路由写 project.import）
    return { project_id: projectId, id_map };
  });
}

async function mergeConfiguration(
  targetProjectId: string,
  pack: OpenedPack,
  modules: ModuleKey[],
  body: ApplyBody,
): Promise<Record<string, unknown>> {
  const [p] = await sql`SELECT * FROM projects WHERE id = ${targetProjectId}`;
  if (!p) throw Object.assign(new Error("target project not found"), { code: "NO_TARGET" });

  const policy = body.conflict_policy ?? "use_source";
  const id_map: Record<string, unknown> = { credentials: body.credential_mappings ?? {} };

  return await sql.begin(async (tx) => {
    const cfg = { ...((p.config_json ?? {}) as Record<string, unknown>) };

    if (modules.includes("rules")) {
      const rulesFile = readJson<{ rules?: Record<string, unknown> }>(pack.files, "data/rules.json");
      if (rulesFile?.rules) {
        if (policy === "use_source") cfg.rules = { ...((cfg.rules as object) ?? {}), ...rulesFile.rules };
        else if (policy === "keep_target") {
          /* keep */
        } else cfg.rules = { ...rulesFile.rules, ...((cfg.rules as object) ?? {}) };
      }
    }

    if (modules.includes("roles")) {
      const enabledFile = readJson<{ enabled?: string[] | null }>(pack.files, "data/roles-enabled.json");
      if (enabledFile && policy !== "keep_target") {
        cfg.roles = { enabled: enabledFile.enabled ?? null };
      }
      await importRoleConfigs(
        tx as Tx,
        targetProjectId,
        pack,
        {
          role_configs: {},
          credentials: (id_map.credentials as Record<string, string>) ?? {},
        },
        policy === "keep_target",
        parseProjectImagePolicy(cfg),
      );
    }

    await tx`UPDATE projects SET config_json = ${tx.json(cfg as never)}, updated_at = now() WHERE id = ${targetProjectId}`;
    return id_map;
  });
}

// postgres.js 事务连接与 Sql 类型不完全一致，导入路径统一用宽松 helper
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

async function importRoleConfigs(
  tx: Tx,
  projectId: string,
  pack: OpenedPack,
  id_map: {
    role_configs: Record<string, string>;
    credentials: Record<string, string>;
  },
  skipExisting = false,
  imagePolicy: ProjectImagePolicy = parseProjectImagePolicy(undefined),
) {
  // Keep imported RoleConfig bindings in the same critical section as the
  // Credential provider/project/metadata mutation path.  Credential PATCH
  // takes this lock before its row lock, so imported bindings cannot race its
  // consumer validation.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
  const configs = readJsonl(pack.files, "data/role-configs.jsonl");
  for (const rc of configs) {
    const roleName = String(rc.role_name);
    const [role] = await tx`SELECT id FROM agent_roles WHERE name = ${roleName}`;
    if (!role) continue; // 自定义角色未创建时跳过（builtin 名应存在）

    const agentCli = typeof rc.agent_cli === "string" && rc.agent_cli ? rc.agent_cli : "claude-code";
    const dshTaskMode = parseTransferredDshTaskMode(rc.dsh_task_mode, `RoleConfig ${roleName}`);
    const model = persistableProjectRoleConfigModel(
      imagePolicy,
      typeof rc.model === "string" && rc.model ? rc.model : null,
    );
    const rawContextWindowTokens = rc.context_window_tokens ?? null;
    if (rawContextWindowTokens !== null && (
      typeof rawContextWindowTokens !== "number"
      || !Number.isSafeInteger(rawContextWindowTokens)
      || rawContextWindowTokens < 1_024
      || rawContextWindowTokens > 10_000_000
    )) {
      throw new Error(`RoleConfig ${roleName} 的 context_window_tokens 非法`);
    }
    const contextWindowTokens = rawContextWindowTokens as number | null;

    if (skipExisting) {
      const [ex] = await tx`
        SELECT id FROM role_configs WHERE project_id = ${projectId} AND role_id = ${role.id as string}`;
      if (ex) continue;
    }

    const moduleSelectors = rc.modules_json == null
      ? []
      : validateModuleSelectors(rc.modules_json, `RoleConfig ${roleName}.modules_json`);
    const piExtErr = validatePiExtensionIds(rc.pi_extensions_json ?? [], agentCli);
    if (piExtErr) throw new Error(`RoleConfig ${roleName}.pi_extensions_json: ${piExtErr}`);
    const sandboxLimits = parseSandboxLimitsOverride(rc.sandbox_limits_json);
    const runtimeKnobs = parseRuntimeKnobOverride(rc.runtime_knobs_json);

    // upsert 项目覆盖
    await tx`DELETE FROM role_configs WHERE project_id = ${projectId} AND role_id = ${role.id as string}`;
    const [created] = await tx`
      INSERT INTO role_configs ${tx({
        role_id: role.id as string,
        project_id: projectId,
        agent_cli: agentCli,
        dsh_task_mode: dshTaskMode,
        model,
        context_window_tokens: contextWindowTokens,
        env_keys: (rc.env_keys as string[]) ?? [],
        env_vars_json: ((rc.env_vars as object) ?? {}) as never,
        modules_json: moduleSelectors as never,
        skills_json: ((rc.skills_json as unknown) ?? []) as never,
        commands_json: ((rc.commands_json as unknown) ?? []) as never,
        mcps_json: ((rc.mcps_json as unknown) ?? []) as never,
        subagents_json: ((rc.subagents_json as unknown) ?? []) as never,
        platform_tools_json: ((rc.platform_tools_json as unknown) ?? {}) as never,
        sandbox_limits_json: sandboxLimits as never,
        runtime_knobs_json: runtimeKnobs as never,
        pi_extensions_json: ((rc.pi_extensions_json as unknown) ?? []) as never,
        instructions_markdown: (rc.instructions_markdown as string) ?? null,
        runtime_image_key: null,
        version: 1,
      })}
      RETURNING id`;

    if (rc.source_id) id_map.role_configs[String(rc.source_id)] = created.id as string;

    const files = (rc.files as { path: string; content: string; content_sha256: string }[]) ?? [];
    for (const f of files) {
      await tx`
        INSERT INTO role_config_files ${tx({
          role_config_id: created.id as string,
          path: f.path,
          content: f.content,
          content_sha256: f.content_sha256,
        })}
        ON CONFLICT (role_config_id, path) DO UPDATE SET
          content = EXCLUDED.content,
          content_sha256 = EXCLUDED.content_sha256,
          updated_at = now()`;
    }

    // Credential 绑定：仅当 mapping 存在
    const creds = (rc.credentials as { source_credential_id: string; purpose?: string }[]) ?? [];
    for (const c of creds) {
      const targetCred = id_map.credentials[c.source_credential_id];
      if (!targetCred) continue;
      const [credential] = await tx`
        SELECT id, project_id, provider, public_metadata_json, settings_config_json, agent_cli
        FROM credentials WHERE id = ${targetCred} FOR UPDATE`;
      if (!credential) throw new Error(`Credential 不存在: ${targetCred}`);
      const purpose = c.purpose ?? "llm";
      const bindingError = validateCredentialRoleConfigBinding({
        source: `RoleConfig ${roleName} → Credential ${targetCred}`,
        purpose,
        agentCli,
        model,
        credentialProjectId: (credential.project_id as string | null) ?? null,
        roleConfigProjectId: projectId,
        provider: String(credential.provider ?? ""),
        metadata: credential.public_metadata_json,
        settingsConfig: credential.settings_config_json,
        credentialAgentCli: (credential.agent_cli as string | null) ?? null,
      });
      if (bindingError) throw new Error(bindingError);
      await tx`
        INSERT INTO role_credentials ${tx({
          role_config_id: created.id as string,
          credential_id: targetCred,
          purpose,
        })}
        ON CONFLICT DO NOTHING`;
    }
  }
}

async function importTasks(
  tx: Tx,
  projectId: string,
  pack: OpenedPack,
  modules: ModuleKey[],
  id_map: {
    canvases: Record<string, string>;
    jobs: Record<string, string>;
    nodes: Record<string, string>;
    findings: Record<string, string>;
  },
) {
  const canvases = readJsonl(pack.files, "data/canvases.jsonl");
  for (const c of canvases) {
    const newId = randomUUID();
    id_map.canvases[String(c.source_id)] = newId;
    await tx`
      INSERT INTO canvases ${tx({
        id: newId,
        project_id: projectId,
        title: (c.title as string) ?? "imported task",
        target_json: ((c.target_json as object) ?? {}) as never,
        trigger_source: "import",
        trigger_event_id: null,
        trigger_payload_json: { import_origin: c.source_id } as never,
      })}`;
  }

  // jobs 阶段 1：无 parent/finding
  const jobs = readJsonl(pack.files, "data/jobs.jsonl");
  for (const j of jobs) {
    const newId = randomUUID();
    id_map.jobs[String(j.source_id)] = newId;
    const canvasId = j.source_canvas_id ? id_map.canvases[String(j.source_canvas_id)] ?? null : null;
    const arch = archiveJobStatus(String(j.status ?? "cancelled"));
    const payload = {
      ...((j.payload_json as object) ?? {}),
      import_origin: {
        source_job_id: j.source_id,
        original_status: arch.original_status,
      },
    };
    // agent_snapshot_json 必填
    const snap = await freezeAgentSnapshotNetworkPolicy(
      tx as unknown as typeof sql,
      canvasId,
      ((j.agent_snapshot_json as object) ?? { name: j.type, agent_cli: "claude-code" }),
    );
    await tx`
      INSERT INTO jobs ${tx({
        id: newId,
        project_id: projectId,
        canvas_id: canvasId,
        parent_job_id: null,
        finding_id: null,
        type: (j.type as string) ?? "audit",
        status: arch.status,
        priority: (j.priority as number) ?? 0,
        payload_json: payload as never,
        agent_snapshot_json: snap as never,
        // 导入历史不调度
        sandbox_id: null,
        lease_expires_at: null,
        heartbeat_at: null,
        claimed_at: null,
        timeout_sec: (j.timeout_sec as number) ?? 7200,
        followup_depth: (j.followup_depth as number) ?? 0,
        transcript_uri: null,
        error: j.error ?? null,
        started_at: null,
        finished_at: j.finished_at ?? new Date().toISOString(),
      })}`;
  }

  // nodes
  const nodes = readJsonl(pack.files, "data/nodes.jsonl");
  for (const n of nodes) {
    const newId = randomUUID();
    id_map.nodes[String(n.source_id)] = newId;
    const canvasId = id_map.canvases[String(n.source_canvas_id)];
    if (!canvasId) continue;
    const jobId = n.source_job_id ? id_map.jobs[String(n.source_job_id)] ?? null : null;
    const verificationStatus = n.node_type === "fact"
      ? FactVerificationStatus.safeParse(n.verification_status)
      : null;
    if (n.node_type === "fact" && !verificationStatus?.success) {
      throw Object.assign(new Error("Fact verification_status 不符合 tasks v2 契约"), {
        code: "BAD_FACT_VERIFICATION_STATUS",
      });
    }
    if (n.node_type !== "fact" && n.verification_status != null) {
      throw Object.assign(new Error("非 Fact 节点的 verification_status 必须为 null"), {
        code: "BAD_FACT_VERIFICATION_STATUS",
      });
    }
    await tx`
      INSERT INTO canvas_nodes ${tx({
        id: newId,
        canvas_id: canvasId,
        job_id: jobId,
        node_type: n.node_type as string,
        title: (n.title as string) ?? "",
        body_json: ((n.body_json as object) ?? {}) as never,
        x: (n.x as number) ?? 0,
        y: (n.y as number) ?? 0,
        w: (n.w as number) ?? 240,
        h: (n.h as number) ?? 120,
        status: (n.status as string) ?? null,
        verification_status: verificationStatus?.success ? verificationStatus.data : null,
      })}`;
  }

  // findings
  if (modules.includes("findings")) {
    const findings = readJsonl(pack.files, "data/findings.jsonl");
    for (const f of findings) {
      const jobId = id_map.jobs[String(f.source_job_id)];
      if (!jobId) continue;
      const newId = randomUUID();
      id_map.findings[String(f.source_id)] = newId;
      const nodeId = f.source_node_id ? id_map.nodes[String(f.source_node_id)] ?? null : null;
      try {
        await tx`
          INSERT INTO findings ${tx({
            id: newId,
            project_id: projectId,
            job_id: jobId,
            node_id: nodeId,
            fingerprint: f.fingerprint as string,
            title: f.title as string,
            severity: f.severity as string,
            location: (f.location as string) ?? null,
            summary: (f.summary as string) ?? null,
            suggest_verify: Boolean(f.suggest_verify),
            verify_status: (f.verify_status as string) ?? "pending",
            raw_json: ((f.raw_json as object) ?? {}) as never,
          })}`;
      } catch {
        // fingerprint 冲突则跳过
      }
    }
  }

  // jobs 阶段 2：parent / finding
  for (const j of jobs) {
    const newId = id_map.jobs[String(j.source_id)];
    if (!newId) continue;
    const parent = j.source_parent_job_id ? id_map.jobs[String(j.source_parent_job_id)] ?? null : null;
    const finding = j.source_finding_id ? id_map.findings[String(j.source_finding_id)] ?? null : null;
    if (parent || finding) {
      await tx`
        UPDATE jobs SET parent_job_id = ${parent}, finding_id = ${finding} WHERE id = ${newId}`;
    }
  }

  // edges
  const edges = readJsonl(pack.files, "data/edges.jsonl");
  for (const e of edges) {
    const canvasId = id_map.canvases[String(e.source_canvas_id)];
    const from = id_map.nodes[String(e.source_from_node_id)];
    const to = id_map.nodes[String(e.source_to_node_id)];
    if (!canvasId || !from || !to) continue;
    await tx`
      INSERT INTO canvas_edges ${tx({
        canvas_id: canvasId,
        from_node_id: from,
        to_node_id: to,
        edge_type: (e.edge_type as string) ?? "child",
      })}`;
  }

  // events（可选，量大）
  if (modules.includes("events")) {
    const events = readJsonl(pack.files, "data/events.jsonl");
    for (const ev of events) {
      const jobId = id_map.jobs[String(ev.source_job_id)];
      if (!jobId) continue;
      try {
        await tx`
          INSERT INTO events ${tx({
            job_id: jobId,
            event_id: String(ev.event_id),
            job_seq: Number(ev.job_seq),
            type: String(ev.type),
            payload_json: ((ev.payload_json as object) ?? {}) as never,
          })}
          ON CONFLICT DO NOTHING`;
      } catch {
        /* skip */
      }
    }
  }
}
