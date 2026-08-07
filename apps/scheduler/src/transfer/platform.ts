/**
 * 平台配置导入导出（全局规则 / 角色注册表 / 全局 RoleConfig / Skill 源 / 凭据元数据）
 * 与项目 .deepsonarpack 共用 ZIP 容器，format 区分。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { validateModuleSelectors } from "@deepsonar/shared-types";
import {
  projectCredentialMetadata,
  projectCredentialProvider,
  validateCredentialRoleConfigBinding,
} from "../credentials.js";
import { DISPATCH_CLAIM_ADVISORY_KEY } from "../core.js";
import {
  ROLE_COLOR_ADVISORY_KEY,
  normalizeRoleUiColor,
  resolveImportedRoleUiColor,
} from "../role-colors.js";
import { sql } from "../db.js";
import {
  buildManifestSource,
  ensureTransferDirs,
  openDeepsonarPack,
  readJson,
  readJsonl,
  loadPackFile,
  toJsonl,
  transferRoot,
  writeDeepsonarPack,
  type Manifest,
  type PackFile,
} from "./pack.js";
import { filterEnvVars } from "./sanitize.js";

export const PLATFORM_FORMAT = "deepsonar-platform-export";
export const PLATFORM_FORMAT_VERSION = "1.0";

export type PlatformModule =
  | "global_rules"
  | "agent_roles"
  | "global_role_configs"
  | "skill_sources"
  | "credentials";

export type PlatformPreset = "platform_full" | "custom";

export interface PlatformManifestOptions {
  preset: PlatformPreset;
  modules: PlatformModule[];
  counts: Record<string, number>;
  credentialsMode: "excluded" | "metadata";
  instanceId: string;
}

/** Build the platform export manifest with the current Scheduler schema baseline. */
export function buildPlatformManifest(options: PlatformManifestOptions): Manifest {
  return {
    format: PLATFORM_FORMAT as Manifest["format"],
    format_version: PLATFORM_FORMAT_VERSION,
    created_at: new Date().toISOString(),
    source: buildManifestSource({
      app_version: "0.0.1",
      instance_id: `sha256:${options.instanceId}`,
      project_id: "platform",
      project_name: "platform",
    }),
    preset: options.preset as Manifest["preset"],
    modules: options.modules as unknown as Manifest["modules"],
    counts: options.counts,
    compatibility: {
      minimum_importer_version: "1.0",
      module_versions: Object.fromEntries(options.modules.map((m) => [m, 1])),
    },
    secrets: { mode: options.credentialsMode === "excluded" ? "excluded" : "metadata", algorithm: null },
    signature: null,
  };
}

const PLATFORM_PRESETS: Record<"platform_full", PlatformModule[]> = {
  platform_full: ["global_rules", "agent_roles", "global_role_configs", "skill_sources", "credentials"],
};

export function resolvePlatformModules(
  preset: PlatformPreset,
  modules?: string[],
): PlatformModule[] {
  if (preset === "custom" && modules?.length) {
    return modules.filter((m): m is PlatformModule =>
      ["global_rules", "agent_roles", "global_role_configs", "skill_sources", "credentials"].includes(m),
    );
  }
  return [...PLATFORM_PRESETS.platform_full];
}

function instanceFingerprint(): string {
  const host = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "local";
  return createHash("sha256").update(`deepsonar-platform:${host}`).digest("hex").slice(0, 16);
}

export async function runPlatformExport(exportId: string): Promise<void> {
  const [row] = await sql`SELECT * FROM data_exports WHERE id = ${exportId}`;
  if (!row || row.status === "cancelled") return;
  if ((row.scope as string) !== "platform") return;

  const claim = await sql`
    UPDATE data_exports SET status = 'collecting', started_at = coalesce(started_at, now()),
      claimed_at = now(), heartbeat_at = now(), attempts = attempts + 1
    WHERE id = ${exportId} AND status IN ('pending','collecting')
    RETURNING *`;
  if (!claim[0]) return;

  const options = (claim[0].options_json ?? {}) as {
    preset?: PlatformPreset;
    modules?: string[];
    credentials?: { mode?: "excluded" | "metadata" };
  };
  const preset = (claim[0].preset as PlatformPreset) || options.preset || "platform_full";
  const modules = resolvePlatformModules(
    preset === "custom" ? "custom" : "platform_full",
    (claim[0].modules_json as string[]) ?? options.modules,
  );
  const credMode = options.credentials?.mode ?? "metadata";

  try {
    await sql`UPDATE data_exports SET status = 'packaging', heartbeat_at = now() WHERE id = ${exportId}`;

    const files: PackFile[] = [];
    const counts: Record<string, number> = {};

    files.push({
      path: "data/platform.json",
      content: JSON.stringify(
        {
          kind: "platform",
          note: "全局配置包：不含项目任务/Finding/API Token/主密钥",
        },
        null,
        2,
      ),
    });
    counts.platform = 1;

    if (modules.includes("global_rules")) {
      const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
      files.push({
        path: "data/global-rules.json",
        content: JSON.stringify({ rules: g?.rules_json ?? {} }, null, 2),
      });
      counts.global_rules = 1;
    }

    if (modules.includes("agent_roles")) {
      const roles = await sql`
        SELECT name, title, description, builtin, kind, ui_color FROM agent_roles ORDER BY kind DESC, name`;
      files.push({ path: "data/agent-roles.jsonl", content: toJsonl(roles) });
      counts.agent_roles = roles.length;
    }

    if (modules.includes("global_role_configs")) {
      const configs = await sql`
        SELECT rc.*, ar.name AS role_name
        FROM role_configs rc
        JOIN agent_roles ar ON ar.id = rc.role_id
        WHERE rc.project_id IS NULL`;
      const out = [];
      for (const rc of configs) {
        const moduleSelectors = rc.modules_json == null
          ? []
          : validateModuleSelectors(rc.modules_json, `全局 RoleConfig ${String(rc.role_name)}.modules_json`);
        const { safe, redacted_keys } = filterEnvVars(rc.env_vars_json as Record<string, unknown>);
        const filesRows = await sql`
          SELECT path, content, content_sha256 FROM role_config_files WHERE role_config_id = ${rc.id as string}`;
        const binds = await sql`
          SELECT c.id, c.name, c.kind, c.provider, c.fingerprint, c.last4, rc2.purpose
          FROM role_credentials rc2
          JOIN credentials c ON c.id = rc2.credential_id
          WHERE rc2.role_config_id = ${rc.id as string}`;
        out.push({
          source_id: rc.id,
          role_name: rc.role_name,
          agent_cli: rc.agent_cli,
          model: rc.model,
          reasoning: rc.reasoning,
          env_keys: rc.env_keys,
          env_vars: safe,
          env_vars_redacted: redacted_keys,
          modules_json: moduleSelectors,
          skills_json: rc.skills_json,
          commands_json: rc.commands_json,
          mcps_json: rc.mcps_json,
          subagents_json: rc.subagents_json,
          platform_tools_json: rc.platform_tools_json,
          instructions_markdown: rc.instructions_markdown,
          runtime_image_key: rc.runtime_image_key,
          version: rc.version,
          files: filesRows,
          credentials:
            credMode === "excluded"
              ? []
              : binds.map((b) => ({
                  source_credential_id: b.id,
                  purpose: b.purpose,
                  name: b.name,
                  ...projectCredentialProvider(b.kind, b.provider),
                })),
        });
      }
      files.push({ path: "data/global-role-configs.jsonl", content: toJsonl(out) });
      counts.global_role_configs = out.length;
    }

    if (modules.includes("skill_sources")) {
      const sources = await sql`
        SELECT id, name, repo_url, branch, trust_status, enabled FROM skill_sources ORDER BY name`;
      files.push({
        path: "data/skill-sources.jsonl",
        content: toJsonl(
          sources.map((s) => ({
            source_id: s.id,
            name: s.name,
            repo_url: s.repo_url,
            branch: s.branch,
            // 不继承 trusted：导入侧默认 quarantined
            trust_status_export: "quarantined",
            enabled_export: false,
            source_trust_status: s.trust_status,
            source_enabled: s.enabled,
          })),
        ),
      });
      counts.skill_sources = sources.length;
    }

    if (modules.includes("credentials") && credMode !== "excluded") {
      // 仅全局凭据（project_id IS NULL）
      const creds = await sql`
        SELECT id, name, kind, provider, fingerprint, last4, public_metadata_json, status
        FROM credentials WHERE project_id IS NULL AND status = 'active'`;
      files.push({
        path: "data/credentials.jsonl",
        content: toJsonl(
          creds.map((c) => ({
            source_id: c.id,
            name: c.name,
            kind: c.kind,
            ...projectCredentialProvider(c.kind, c.provider),
            fingerprint: c.fingerprint,
            last4: c.last4,
            public_metadata: projectCredentialMetadata(String(c.kind), String(c.provider), c.public_metadata_json),
            secret_included: false,
            scope: "global",
          })),
        ),
      });
      counts.credentials = creds.length;
    }

    const manifest = buildPlatformManifest({
      preset,
      modules,
      counts,
      credentialsMode: credMode,
      instanceId: instanceFingerprint(),
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

export interface PlatformPreview {
  compatible: boolean;
  kind: "platform";
  source: Manifest["source"];
  selected_modules: PlatformModule[];
  counts: Record<string, number>;
  warnings: string[];
  conflicts: { module: string; key: string; message: string }[];
  credential_mappings_required: { source_id: string; name: string; provider: string; provider_valid?: boolean }[];
}

export async function buildPlatformPreview(importId: string): Promise<PlatformPreview> {
  const [row] = await sql`SELECT * FROM data_imports WHERE id = ${importId}`;
  if (!row) throw Object.assign(new Error("import not found"), { code: "NOT_FOUND" });

  await sql`UPDATE data_imports SET status = 'validating', scope = 'platform' WHERE id = ${importId}`;
  const buf = await loadPackFile(row.source_artifact_uri as string);
  const pack = await openDeepsonarPack(buf);

  if (pack.manifest.format !== PLATFORM_FORMAT) {
    throw Object.assign(new Error(`不是平台配置包（format=${pack.manifest.format}）`), {
      code: "NOT_PLATFORM_PACK",
    });
  }

  const modules = (pack.manifest.modules ?? []) as PlatformModule[];
  const warnings = [
    "平台包会写入全局规则 / 角色 / 全局 RoleConfig / Skill 源；不会创建项目或任务",
    "Skill 源导入后保持 quarantined，需在目标环境重新审批",
    "Credential 仅元数据，需在目标环境重新录入 Secret 并映射",
  ];
  const conflicts: PlatformPreview["conflicts"] = [];

  const roles = readJsonl(pack.files, "data/agent-roles.jsonl");
  for (const r of roles) {
    if (r.builtin) continue;
    const [ex] = await sql`SELECT id FROM agent_roles WHERE name = ${String(r.name)}`;
    if (ex) {
      conflicts.push({
        module: "agent_roles",
        key: String(r.name),
        message: "自定义角色已存在，将更新 title/description（不改 kind/builtin）",
      });
    }
  }

  const sources = readJsonl(pack.files, "data/skill-sources.jsonl");
  for (const s of sources) {
    const [ex] = await sql`SELECT id FROM skill_sources WHERE name = ${String(s.name)}`;
    if (ex) {
      conflicts.push({
        module: "skill_sources",
        key: String(s.name),
        message: "同名 Skill 源已存在，将更新 repo_url/branch，trust 保持目标现状或仍为 quarantined",
      });
    }
  }

  const creds = readJsonl(pack.files, "data/credentials.jsonl");
  let sanitizedCredentialMetadata = 0;
  for (const credential of creds) {
    const safe = projectCredentialMetadata(String(credential.kind ?? ""), String(credential.provider ?? ""), credential.public_metadata);
    if (JSON.stringify(safe) !== JSON.stringify(credential.public_metadata ?? {})) sanitizedCredentialMetadata += 1;
  }
  if (sanitizedCredentialMetadata > 0) {
    warnings.push(`已清理 ${sanitizedCredentialMetadata} 条 Credential 的不安全 legacy metadata；不会原样写入目标库`);
  }
  const preview: PlatformPreview = {
    compatible: true,
    kind: "platform",
    source: pack.manifest.source,
    selected_modules: modules,
    counts: pack.manifest.counts ?? {},
    warnings,
    conflicts,
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
  };

  await sql`
    UPDATE data_imports SET
      status = 'preview_ready',
      scope = 'platform',
      source_manifest_json = ${sql.json(pack.manifest as never)},
      preview_json = ${sql.json(preview as never)},
      selected_modules_json = ${sql.json(modules as never)},
      heartbeat_at = now()
    WHERE id = ${importId}`;

  return preview;
}

export interface PlatformApplyBody {
  mode?: "merge_platform";
  /** keep_target | use_source — 全局规则冲突时 */
  conflict_policy?: "keep_target" | "use_source";
  credential_mappings?: Record<string, string>;
}

export async function applyPlatformImport(
  importId: string,
  body: PlatformApplyBody = {},
): Promise<{ ok: true; summary: Record<string, number> }> {
  const [row] = await sql`SELECT * FROM data_imports WHERE id = ${importId}`;
  if (!row) throw Object.assign(new Error("import not found"), { code: "NOT_FOUND" });
  if (row.status === "succeeded") return { ok: true, summary: {} };

  await sql`
    UPDATE data_imports SET status = 'applying', mode = 'merge_platform',
      claimed_at = now(), started_at = coalesce(started_at, now()), attempts = attempts + 1
    WHERE id = ${importId}`;

  try {
    const buf = await loadPackFile(row.source_artifact_uri as string);
    const pack = await openDeepsonarPack(buf);
    if (pack.manifest.format !== PLATFORM_FORMAT) {
      throw Object.assign(new Error("不是平台配置包"), { code: "NOT_PLATFORM_PACK" });
    }

    const policy = body.conflict_policy ?? "use_source";
    const summary: Record<string, number> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Tx = any;

    await sql.begin(async (txRaw) => {
      const tx = txRaw as Tx;

      // Global RoleConfig imports share the same critical section as
      // Credential provider/project/metadata mutations.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      // Role colors are allocated/remapped under a second transaction-scoped
      // lock so concurrent imports cannot preserve the same source hint.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${ROLE_COLOR_ADVISORY_KEY}))`;

      // global rules
      const rulesFile = readJson<{ rules?: Record<string, unknown> }>(pack.files, "data/global-rules.json");
      if (rulesFile?.rules) {
        const [g] = await tx`SELECT rules_json FROM global_settings WHERE id = 'global'`;
        const current = ((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>;
        const merged =
          policy === "keep_target"
            ? { ...rulesFile.rules, ...current }
            : { ...current, ...rulesFile.rules };
        await tx`UPDATE global_settings SET rules_json = ${tx.json(merged as never)}, updated_at = now() WHERE id = 'global'`;
        summary.global_rules = 1;
      }

      // agent roles
      const roles = readJsonl(pack.files, "data/agent-roles.jsonl");
      type ExistingRole = {
        id: string;
        name: string;
        builtin: boolean;
        kind: string;
        ui_color: string | null;
      };
      const existingRoles = (await tx`SELECT id, name, builtin, kind, ui_color FROM agent_roles`) as ExistingRole[];
      const roleByName = new Map(existingRoles.map((entry) => [entry.name, entry] as const));
      const usedRoleColors = new Set<string>();
      for (const entry of existingRoles) {
        if (entry.kind !== "role") continue;
        const color = normalizeRoleUiColor(entry.ui_color);
        if (color) usedRoleColors.add(color);
      }
      let roleN = 0;
      for (const r of roles) {
        const name = String(r.name);
        const ex = roleByName.get(name);
        if (ex) {
          if (ex.kind === "role") {
            // Remove this role's old color before resolving its replacement;
            // this lets a round-trip import keep its own legal color while
            // still remapping collisions with every other role.
            const previous = normalizeRoleUiColor(ex.ui_color);
            if (previous) usedRoleColors.delete(previous);
            const resolved = resolveImportedRoleUiColor(r.ui_color, ex.ui_color, usedRoleColors);
            usedRoleColors.add(resolved);
            await tx`
              UPDATE agent_roles SET
                title = ${String(r.title ?? "")},
                description = ${String(r.description ?? "")},
                ui_color = ${resolved},
                updated_at = now()
              WHERE id = ${ex.id}`;
            ex.ui_color = resolved;
          } else {
            // System / hub roles use fixed semantic canvas colors and remain
            // uncolored in the role registry regardless of pack contents.
            await tx`
              UPDATE agent_roles SET
                title = ${String(r.title ?? "")},
                description = ${String(r.description ?? "")},
                ui_color = NULL,
                updated_at = now()
              WHERE id = ${ex.id}`;
          }
        } else if (!r.builtin) {
          const resolved = resolveImportedRoleUiColor(r.ui_color, null, usedRoleColors);
          usedRoleColors.add(resolved);
          await tx`
            INSERT INTO agent_roles ${tx({
              name,
              title: String(r.title ?? name),
              description: String(r.description ?? ""),
              builtin: false,
              kind: "role",
              ui_color: resolved,
            })}`;
        } else if (r.kind === "system" || r.kind === "hub") {
          // A platform pack may be restored into a catalog missing one of the
          // governed semantic roles.  Recreate it with an explicit NULL color;
          // semantic colors belong to the canvas renderer, never to imports.
          await tx`
            INSERT INTO agent_roles ${tx({
              name,
              title: String(r.title ?? name),
              description: String(r.description ?? ""),
              builtin: true,
              kind: r.kind,
              ui_color: null,
            })}`;
        }
        // builtin 缺失则跳过（应由 schema 基线提供）
        roleN++;
      }
      summary.agent_roles = roleN;

      // skill sources
      const sources = readJsonl(pack.files, "data/skill-sources.jsonl");
      let srcN = 0;
      for (const s of sources) {
        const name = String(s.name);
        const [ex] = await tx`SELECT id, trust_status FROM skill_sources WHERE name = ${name}`;
        if (ex) {
          await tx`
            UPDATE skill_sources SET
              repo_url = ${String(s.repo_url)},
              branch = ${String(s.branch ?? "main")}
            WHERE name = ${name}`;
        } else {
          await tx`
            INSERT INTO skill_sources ${tx({
              name,
              repo_url: String(s.repo_url),
              branch: String(s.branch ?? "main"),
              trust_status: "quarantined",
              enabled: false,
            })}`;
        }
        srcN++;
      }
      summary.skill_sources = srcN;

      // global role configs
      const configs = readJsonl(pack.files, "data/global-role-configs.jsonl");
      let cfgN = 0;
      const credMap = body.credential_mappings ?? {};
      for (const rc of configs) {
        const roleName = String(rc.role_name);
        const [role] = await tx`SELECT id FROM agent_roles WHERE name = ${roleName}`;
        if (!role) continue;

        const agentCli = typeof rc.agent_cli === "string" && rc.agent_cli ? rc.agent_cli : "claude-code";
        const model = typeof rc.model === "string" && rc.model ? rc.model : null;
        const moduleSelectors = rc.modules_json == null
          ? []
          : validateModuleSelectors(rc.modules_json, `全局 RoleConfig ${roleName}.modules_json`);

        await tx`DELETE FROM role_configs WHERE project_id IS NULL AND role_id = ${role.id as string}`;
        const [created] = await tx`
          INSERT INTO role_configs ${tx({
            role_id: role.id as string,
            project_id: null,
            agent_cli: agentCli,
            model,
            reasoning: (rc.reasoning as string) ?? null,
            env_keys: (rc.env_keys as string[]) ?? [],
            env_vars_json: ((rc.env_vars as object) ?? {}) as never,
            // Preserve legal plugin/source selectors exactly; resolution waits
            // for the next Job snapshot on the target catalog.
            modules_json: moduleSelectors as never,
            skills_json: ((rc.skills_json as unknown) ?? []) as never,
            commands_json: ((rc.commands_json as unknown) ?? []) as never,
            mcps_json: ((rc.mcps_json as unknown) ?? []) as never,
            subagents_json: ((rc.subagents_json as unknown) ?? []) as never,
            platform_tools_json: ((rc.platform_tools_json as unknown) ?? {}) as never,
            instructions_markdown: (rc.instructions_markdown as string) ?? null,
            runtime_image_key: (rc.runtime_image_key as string) ?? null,
            version: 1,
          })}
          RETURNING id`;

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

        const binds = (rc.credentials as { source_credential_id: string; purpose?: string }[]) ?? [];
        for (const b of binds) {
          const target = credMap[b.source_credential_id];
          if (!target) continue;
          const [credential] = await tx`
            SELECT id, project_id, provider, public_metadata_json, settings_config_json, agent_cli
            FROM credentials WHERE id = ${target} FOR UPDATE`;
          if (!credential) throw new Error(`Credential 不存在: ${target}`);
          const purpose = b.purpose ?? "llm";
          const bindingError = validateCredentialRoleConfigBinding({
            source: `全局 RoleConfig ${roleName} → Credential ${target}`,
            purpose,
            agentCli,
            model,
            credentialProjectId: (credential.project_id as string | null) ?? null,
            roleConfigProjectId: null,
            provider: String(credential.provider ?? ""),
            metadata: credential.public_metadata_json,
            settingsConfig: credential.settings_config_json,
            credentialAgentCli: (credential.agent_cli as string | null) ?? null,
          });
          if (bindingError) throw new Error(bindingError);
          await tx`
            INSERT INTO role_credentials ${tx({
              role_config_id: created.id as string,
              credential_id: target,
              purpose,
            })}
            ON CONFLICT DO NOTHING`;
        }
        cfgN++;
      }
      summary.global_role_configs = cfgN;
    });

    await sql`
      UPDATE data_imports SET status = 'succeeded', finished_at = now(),
        id_map_json = ${sql.json({ summary } as never)}, error = null
      WHERE id = ${importId}`;
    return { ok: true, summary };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "APPLY_FAILED";
    await sql`
      UPDATE data_imports SET status = 'failed', error = ${msg}, error_code = ${code}, finished_at = now()
      WHERE id = ${importId}`;
    throw e;
  }
}

/** 根据包 manifest 判断是否平台包 */
export function isPlatformPackFormat(format: string): boolean {
  return format === PLATFORM_FORMAT;
}
