import { createHash } from "node:crypto";

/** 平台控制协议 Skill 的保留名称；它不是业务能力 Skill。 */
export const DEEPSONAR_CONTROL_SKILL_NAME = "deepsonar-control" as const;

/** Shared by the fixed Skill and startup/nudge prompts; no secret values are rendered. */
export const PLATFORM_CONTROL_HTTP_BOOTSTRAP = [
  "平台清单中的 HTTP operation 不是 CLI 原生工具，也不是 Shell 命令；角色示例 operation({...}) 只描述 operation 和 JSON payload，不可当作同名工具调用。",
  "首次平台操作前读取平台注入的 deepsonar-control Skill，并用 CLI 已有的 HTTP 工具（例如通过 bash 运行 curl 或 Node）调用 GET $DEEPSONAR_API_BASE_URL/agent/capabilities_list。BASE_URL 已包含本 Job 路径，不要再次拼接 Job ID。",
  "按发现返回的 schema 构造 JSON，调用 POST $DEEPSONAR_API_BASE_URL/operations/:operationId（用已授权 operation 替换占位符）。GET/POST 均带 Authorization: Bearer $DEEPSONAR_API_TOKEN；POST 带 Content-Type: application/json 和 UUID Idempotency-Key；仅 mark_job_done 还必须带 X-DeepSonar-Proposal-Revision，首次为 0，修正按反馈递增。只在请求进程中使用凭据，禁止打印或写入任务文件。",
  "原生工具返回 not found 不代表 Control API 拒绝，也不代表缺少授权；重读控制 Skill 后使用上述 HTTP 入口，不增加同名工具或改走其他通道。",
  "拒绝按 repair.category 与 next_action 处理；结果未知按该 operation 契约查询原回执或当前状态，不支持查询时保留未知并停止，禁止猜测查询路由或换 key 重放。已接受提案不得用新 key 或修改 payload/revision 新建另一提案。只有 operation 明确支持回执恢复、查得原 persisted_deferred 且原 Job/Attempt/执行器满足恢复条件时，才允许原 key、适用的原 revision 和完全相同 payload 再 POST，仅恢复原执行器本地提案，不重放外部效果；文件输入保持原路径与内容。明确可修正拒绝才用新 key，完成提案还需反馈要求的下一 revision。人工请求接纳后停止业务执行，不提完成或冲突终态；原样传输恢复不授权继续业务。accepted/persisted_deferred 不等于 Job 成功，详情见 deepsonar-control Skill。",
].join("\n");

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

${PLATFORM_CONTROL_HTTP_BOOTSTRAP}

## 可行动人工请求

request_human 的 reason 说明真实阻塞与已有证据，subject 绑定明确目标；还必须提供严格 guidance：question、required_action、reply_instructions、after_reply 四个字段，不能只提交一段工作汇报。question 先说明问题、影响和需要用户作出的具体决定；required_action 逐项列出用户需要准备的输入、执行的操作和已核实的位置；reply_instructions 写清回复格式、必要的非秘密引用，以及可以拒绝或暂不提供的选择；after_reply 说明收到不同回复后的业务计划。
凭据只能经已确认且受治理的安全配置方式提供，回复和附件不得包含密码、令牌等秘密；配置入口未知时明确说明未知，不捏造菜单、接口或凭据能力。回复不扩权，不等于 Agent ACK 或任务完成，也不保证恢复：Scheduler 仍核对原权限、预算、期限和未决效果。平台可对账故障不得伪装成人的业务决策。
只有确需当前用户提供输入或决定时才请求人工；已能在当前授权内核实的事项自行完成。reason 最多 2000 字符；guidance 各字段必须 trim 后非空并满足能力目录返回的长度约束。请求被拒绝时按 RepairFeedback 修正；接纳后停止，不再提交冲突终态。

## 有界 Plan 决策

本节只适用于显式启用的执行型 Plan。普通 Hub 任务没有 plan_objective 声明，当前没有活动 Plan，且不存在历史显式 Plan owner 时，仍可通过 submit_hub_decision 提交普通 complete 或 intents；不得仅因 plan_objective 缺失而停止或 request_human。已有 plan_objective、活动 Plan 或历史显式 Plan owner 时，如果当前目标读取失败、缺失、状态无效、不完整或预算不足，应停止或 request_human，不得回退普通 intents 来绕过 Plan。

plan_gap 的 supplementation_execution 仅描述历史一次补证关联，不覆盖整个目标。历史 v1 返回 historical=true、supplementation_remaining=0，只可读取，不能再派发或完成。succeeded 不等于判据满足或阴性；reported_blocker 只是 Agent 的结构化报告，unknown 不得重放。
显式 submit_plan 后，可用 graph_query(kind=plan_gap,id=Plan Job UUID,ids=最多四个 Fact UUID,cursor=返回游标,limit=最多4)读取当前判据、来源、revision 与内容 SHA；v2 还返回 objective/route revision、budget 和执行停止投影。沿用查询预算和本 Job 已见引用；翻页读完必要判据后才能提交 complete。plan_basis 使用返回版本，只用于完成提案或安全人工停止；继续执行必须提交当前 v2 execution_route，不能以单步 Intent 绕过依赖与预算。全部必要判据必须具有当前有效的操作员 satisfies 评价；verified、阴性观察、模型 done 都不能单独证明完成。预算耗尽或无法确认时使用 request_human；带依据的停止使用 blocked/needs_human 与 platform_blocker.business_decision。依据过期先重读，unknown effect 禁止重放；查询预算耗尽仍可普通 request_human。
带 plan_basis 的 submit_hub_decision/request_human（含 payload_file）成功返回持久 persisted_deferred 接纳回执，不代表派发或完成。响应丢失时 GET 对应 operation?receipt_key=<原UUID> 只读原结果；POST 完全相同的 key/输入只可恢复原活动 Attempt 的本地提案，不启动新执行。文件输入重试必须保持原路径与内容；未知效果不重放。无活动 handler 时只能读取接纳结果，不推断执行成功。

### 执行型 Plan v2

首次 v2 submit_plan 前，Hub 必须先通过本 Job 的 graph_query({kind:"plan_objective"}) 读取当前用户目标。只有 truncated=false 且 items[0] 为完整 tuple 时才可继续；将返回的 objective_id 原样写入 plan.objective_id 与 revision.objective_id，将 revision 原样写入 plan.objective_revision 与 revision.expected_objective_revision，并将 goal、completion、budget 原样复制到 plan；input_sha256、status、updated_at 只用于核对当前目标版本，不是严格 v2 Plan 的提交字段。不能从 YAML read handle、旧 task 文本或模型记忆猜测，也不能削弱或替换任何用户字段。该读取是完整 tuple 的唯一 bootstrap 入口；读取失败、缺失或预算不足时不得提交 Plan。
用户先通过管理面的 PATCH /tasks/:canvasId 以 expected_revision CAS 写入 plan_objective；模型不得提交、削弱或替换 goal、completion 或 lifetime budget。执行型 Plan 的新执行必须提交 plan.v=2 与 v2 execution_route revision；v1 只作为历史审计，不通过兼容 fallback 进入新执行。Scheduler 只把当前路线的 ready task 通过既有 Hub Intent/Job materializer 派发，依赖必须来自成功的当前 Attempt 以及未拒绝的 Fact/Finding Artifact/Evidence，不接受 PlanResult/done-only 作为输出。路线修订只影响尚未派发 task，已派发 task 的 SHA 必须保持不变。
每个 task 必须声明非空且唯一的 expected_outputs。Worker 按 Scheduler 注入的输出合约，通过 emit_fact/emit_finding 的 artifact.extensions["plan.output"] 提交 v=2、objective_id、objective_revision、task_id、task_sha256 和本次覆盖的精确 expected_outputs 名称，附当前 Attempt 的留存文件 URI/SHA256。只有当前目标版本的匹配输出及 manifest/实际字节验证通过，才可释放依赖。该关联不提供语义完成权威。已成功接纳 v2 Plan/Result 的 Hub 用 mark_job_done 结束本轮，不再重复提交派发 Intent。
生命周期预算（max_tasks、max_rounds、max_parallel_tasks、max_no_progress_rounds）跨新的 key、标题、目标修订和 Hub Job 继续累计；取消、超时、失败、unknown effect、缺失输出、依赖失败和无进展会持久停止。重启从 Canvas projection 与不可变 Job/event/Artifact/Evidence 重建，不重放未知副作用。PlanResult 的 complete 不是完成授权，仍须既有 Hub、Verify 和 Report 正向门。


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
运行 env 里除上述变量还有本 Job 的 Gateway / 控制通道凭据，属于平台机制性 secret：不要用
\`env\` / \`printenv\` 批量导出，也不要把 env 原文写进证据、产物或命令输出。需要能力清单就
调用 capabilities_list 或读运行清单。目前只有 Pi 运行时已登记的主请求 / OM SDK context 字符串值
做精确替换（\`[REDACTED]\`）；其它 CLI 与出口不得假定自动脱敏，凭据一旦进入模型输入仍按原值
出站。Gateway 对任何把凭据原值带进出站模型请求的输入保留 fail-closed 拒绝（400
\`credential_in_business_data\`，Job 可能因此终止）。

## 幂等与重试

每次 operation POST 都要有规范 UUID \`Idempotency-Key\`；新请求使用新 key，同一请求的超时或
429/502/503/504 的传输恢复保持相同 key 和完全相同的 payload。收到结构化拒绝时以 repair.category/next_action 为准：明确允许修正的输入错误用新 key，完成提案还需下一 revision；鉴权、终态、策略或未知效果不因状态码而重放。不要用新 key 代替未确定结果的原请求。

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

## 未结算效果的受治理恢复

收到 \`COMPLETION_EFFECT_UNKNOWN\` 或 \`REPAIR_USAGE_UNKNOWN\` 时保留原回执与 Attempt，不重放未知效果，也不把平台可对账故障伪装成用户业务决策。Scheduler 会持久记录恢复事实并在既有权限、租约、暂停和预算边界内安排恢复 Hub；原会话退出或 Job 已终止时，不自动复活或创建新 Attempt。
恢复 Hub 只能处理冻结 \`trigger.recovery_refs\` 授权的对象；先按本 Job 的有界图查询读取恢复摘要，再通过 \`submit_hub_decision.recovery\` 提交 \`recovery_ref\`、精确目标 Job/Attempt、当前 recovery revision/evidence SHA、\`action\` 与有界 \`reason\`。它与 \`complete\`、\`intents\`、\`payload_file\` 和 \`plan_basis\` 互斥，不得夹带其它提案或自造对账证据。
收到 \`recovery_stale\` 后，新投影不授予新权限；用**原冻结 grant** 的全部引用、revision、evidence 提交 \`release_stale\`，然后正常结束当前 Hub。该动作只退出过时授权的工作，不对账、不停止目标、不清除 unknown，也不申请新执行权。Scheduler 在旧 Hub 正常结算、无阻塞未知效果、原期限/预算/权限仍有效时，才可定向授予新的 grant；不能取消自己来假定外部效果已经停止。

\`reconcile_effects\` 只请求 Scheduler 按逐 effect 的宿主证据安全对账；\`stop\` 请求既有生命周期停止。\`interrupted\`、sandbox_id 缺失和 unknown 数量为零都不是完成证明。HTTP 200 仍只表示 \`persisted_deferred\`，不等于已对账、已停止或 Job 成功。旧回执不改写；只有原活动 Attempt 收到允许修正的反馈，才可用新 key/下一 revision 重提完成，并重新经过原来的 Completion、Verify、Plan 与预算门。

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
