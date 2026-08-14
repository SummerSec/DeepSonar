import { createHash } from "node:crypto";

/** 平台静态 Skill 的保留名称。 */
export const DEEPSONAR_CONTROL_SKILL_NAME = "deepsonar-control" as const;

/** 平台注入的固定控制说明，RoleConfig 不能按同名替换。 */
export const DEEPSONAR_CONTROL_SKILL = {
  name: DEEPSONAR_CONTROL_SKILL_NAME,
  files: {
    "SKILL.md": `---
name: deepsonar-control
description: 使用受治理的 DeepSonar Job 控制 API 提交运行提案、证据和完成信号。
---

# DeepSonar 运行控制

这是平台注入的静态 Skill，每个真实 Job 都有一份。RoleConfig 不能按同名替换它。

## 传输方式

所有 CLI 都只能使用 Job 级 HTTP 控制 API；它是所有治理 CLI 的唯一平台控制传输。不要先尝试 MCP，也不要在 API 失败后回退到 MCP。
HTTP API 由 Agent 通过当前 CLI 可用的 HTTP 工具（例如 curl 或 Node）直接调用，Runtime Adapter 只负责驱动 CLI 协议，
不会代为发起 HTTP 请求。若运行清单未声明 \`platform_control_api=true\`，Job 必须在启动前失败关闭；普通文本不是提交。

## 能力发现与鉴权

运行清单声明 \`platform_control_api=true\` 且注入了 API 环境变量时，\`DEEPSONAR_API_BASE_URL\` 已经指向 \`/control/v1/jobs/:jobId\`，不要再拼接 Job ID，
也不要猜测管理 API。先调用
\`GET $DEEPSONAR_API_BASE_URL/agent/capabilities_list\`；它只返回本 Job 短期 token 当前获准
的操作、参数 Schema、必填字段和约束。需要机器可读完整描述时才调用
\`GET $DEEPSONAR_API_BASE_URL/openapi.json\`，再按返回项使用
\`POST $DEEPSONAR_API_BASE_URL/operations/:operationId\`。

能力发现只用于选择调用，服务端每次仍按 Job token、Job 状态和精确白名单鉴权。请求使用
\`Authorization: Bearer $DEEPSONAR_API_TOKEN\`、Accept JSON；JSON 请求使用 JSON
Content-Type。绝不打印、记录、引用、复制、提交、写入 URL、payload、证据或产物中的 API
环境变量。这个 API 不是管理 API，不能创建任意 Job、读数据库、控制容器或修改 RoleConfig。

## 幂等与重试

每次 API 调用都要有规范 UUID \`Idempotency-Key\`；新请求使用新 key，同一请求的超时或
429/502/503/504 重试保持相同 key 和完全相同的 payload。不要重试参数、鉴权、重复、终态
或策略错误，也不要用新 key 代替未确定结果的原请求。

## 操作与完成

只能调用能力发现和本 Job 冻结的 \`platform_tools\` 操作，遵守返回的参数 Schema、相对
\`/workspace\` 的 \`payload_file\`、当前 YAML UUID 引用和 Hub 角色约束。Hub 必须先提交
决策再完成。API 返回 \`accepted\` 只表示 Scheduler 已接收输入；完成必要工作后必须恰好一次调用已授权的
\`mark_job_done\`。
`,
  },
} as const;

/** 固定 Skill 内容的可审计摘要。 */
export const DEEPSONAR_CONTROL_SKILL_SHA256 = createHash("sha256")
  .update(JSON.stringify(DEEPSONAR_CONTROL_SKILL))
  .digest("hex");

/** 删除 RoleConfig 的同名副本，再追加不可变的平台 Skill。 */
export function injectPlatformControlSkill(skills: readonly unknown[]): unknown[] {
  return [
    ...skills.filter((skill) => !skill || typeof skill !== "object" || Array.isArray(skill)
      || String((skill as { name?: unknown }).name ?? "") !== DEEPSONAR_CONTROL_SKILL_NAME),
    DEEPSONAR_CONTROL_SKILL,
  ];
}

/** 保留快照中的精确操作顺序，API 域不能自行扩大权限。 */
export function frozenPlatformOperations(snapshotTools: readonly string[]): string[] {
  return [...snapshotTools];
}

export interface PlatformApiBaseOptions {
  baseUrl: string;
  jobId: string;
}

/** 构造注入沙箱的 Job 级发现地址。 */
export function platformApiBaseUrl(input: PlatformApiBaseOptions): string {
  const raw = input.baseUrl.trim().replace(/\/+$/u, "");
  if (!raw) throw new Error("platform control API base URL is empty");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("platform control API base URL is invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("platform control API base URL must use HTTP(S)");
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("platform control API base URL must be sandbox-reachable, not localhost");
  }
  if (!url.pathname.endsWith("/control/v1")) throw new Error("platform control API base URL must end in /control/v1");
  return `${raw}/jobs/${encodeURIComponent(input.jobId)}`;
}

export interface FrozenSharedAsset { [key: string]: unknown; scope?: string; key?: string; mount_path?: string; read_path?: string; }

/** 按范围和前缀筛选已经清洗、冻结的共享资产目录。 */
export function filterFrozenSharedAssets(
  catalog: Record<string, unknown>,
  input: { scope?: unknown; prefix?: unknown; limit?: unknown; offset?: unknown } = {},
): Record<string, unknown> {
  const scope = typeof input.scope === "string" ? input.scope : undefined;
  const prefix = typeof input.prefix === "string" ? input.prefix : undefined;
  const all = Array.isArray(catalog.assets) ? catalog.assets : [];
  const matched = all.filter((asset): asset is FrozenSharedAsset => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) return false;
    const candidate = asset as FrozenSharedAsset;
    return (!scope || candidate.scope === scope) && (!prefix || String(candidate.key ?? "").startsWith(prefix));
  });
  const rawLimit = Number.isSafeInteger(input.limit) ? Number(input.limit) : 100;
  const rawOffset = Number.isSafeInteger(input.offset) ? Number(input.offset) : 0;
  const limit = Math.max(0, Math.min(rawLimit, 500));
  const offset = Math.max(0, rawOffset);
  const assets = matched.slice(offset, offset + limit).map((asset) => ({
    ...asset,
    mount_path: asset.mount_path ?? asset.read_path ?? null,
    read_path: asset.read_path ?? asset.mount_path ?? null,
  }));
  return { ...catalog, readonly: true, assets, total: matched.length, limit, offset,
    next_offset: offset + assets.length < matched.length ? offset + assets.length : null };
}
