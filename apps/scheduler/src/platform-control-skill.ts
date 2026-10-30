import { createHash } from "node:crypto";

/** 平台控制协议 Skill 的保留名称；它不是业务能力 Skill。 */
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

## 有界 Plan 决策

显式 submit_plan 后，可用 graph_query(kind=plan_gap,id=Plan Job UUID,ids=最多四个 Fact UUID,cursor=返回游标,limit=最多4)读取当前判据、来源、revision 与内容 SHA。沿用查询预算和本 Job 已见引用；翻页读完必要判据后才能提交 complete。plan_basis 使用返回版本，continue 仅可携带一个既有 Intent，并写明 rationale/expected_gain；每任务仅一次补证，改标题、Plan 或 Job 不能重置。全部必要判据必须具有当前有效的操作员 satisfies 评价；verified、阴性观察、模型 done 都不能单独证明完成。预算耗尽或无法确认时使用 request_human；带依据的停止使用 blocked/needs_human 与 platform_blocker.business_decision。依据过期先重读，unknown effect 禁止重放；查询预算耗尽仍可普通 request_human。
带 plan_basis 的 submit_hub_decision/request_human（含 payload_file）成功返回持久 persisted_deferred 接纳回执，不代表派发或完成。响应丢失时 GET 对应 operation?receipt_key=<原UUID> 只读原结果；POST 完全相同的 key/输入只可恢复原活动 Attempt 的本地提案，不启动新执行。文件输入重试必须保持原路径与内容；未知效果不重放。无活动 handler 时只能读取接纳结果，不推断执行成功。


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

## 失败与修复

可修正错误返回 HTTP 4xx 且 \`accepted=false\`。读取 \`repair\`：\`category\`、\`code\`、\`path\`、
\`expected\`、\`observed_shape\`、\`remaining_budget\` 与 \`next_action\`。\`model_correctable\`
按反馈修正后使用新的 Idempotency-Key 重提；\`transient_retryable\` 等待后用同一 key 重试；
\`unknown_external_effect\` 与 \`permanent_failure\` 不要猜测重放。

## 完成提交的持久回执

仅 \`mark_job_done\` 必须带 \`X-DeepSonar-Proposal-Revision\` 请求头：首次为 0。
语义修正用新 Idempotency-Key 和反馈要求的下一 revision；同一提交的传输重试保持原 key、revision、payload。
不要另设不同的事件 ID。响应丢失先调用
\`GET $DEEPSONAR_API_BASE_URL/operations/mark_job_done?receipt_key=<原UUID>\` 查询；查询受原 Job 权限约束。
查询只读取持久结果，不恢复执行器本地完成门。若查询返回 \`persisted_deferred\` 且原 Job 仍活动，
必须使用原 key、revision 和完全相同 payload 再 POST 一次，让原活动执行器接收该提案；
这不会新建提案或重新执行外部效果。原执行器/会话不可用时停止并交诊断，不启动新会话。
没有查到回执不证明没有外部效果，未知效果先对账，不换 key 猜测重发。

\`receipt_status=persisted_deferred\` 表示完成提案已持久接收，不等于 Job 成功、效果结算或模型已处理。
同 key 改内容或 revision 会冲突；已接受后不要新建另一个完成提案。拒绝计数跨进程保留，
最多记录 8 次拒绝；额度耗尽、无进展、取消、租约或总预算到期时停止修正并按既有人工/失败路径处理。
回执查询不启动 CLI、不创建新 Attempt；不支持原会话续接时停止，不能把重新下发称作同会话恢复。
Job 终态后 Control token 不再可用，由管理面按项目权限查看既有事件记录。

## 操作与完成

只能调用能力发现和本 Job 冻结的 \`platform_tools\` 操作，遵守返回的参数 Schema、相对
\`/workspace\` 的 \`payload_file\`、当前 YAML UUID 引用和 Hub 角色约束。Hub 必须先提交
决策再完成。完成必要工作后提交已授权的 \`mark_job_done\`，只有明确拒绝且允许修正时才提交新 revision；
其它操作的 \`accepted\` 语义按该操作契约判断，不能据此推定整个 Job 成功。
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
