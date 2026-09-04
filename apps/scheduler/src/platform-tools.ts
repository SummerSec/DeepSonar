import { SHARED_ASSETS_READONLY_ROOT } from "./domains/shared-assets/catalog.js";

const PLATFORM_TOOL_USAGE: Record<string, string> = {
  list_available_roles: [
    "### `list_available_roles` — 查询 Hub 当前可派发角色",
    "- 参数：无参数，调用时传空对象 `{}`。",
    "- 时机：Hub 判断需要派发 Worker 时先调用；返回本 Job 从数据库冻结的角色 name、title、description。只允许原样使用返回的 name。",
    "- 边界：结果只含 `kind=role` 且当前项目启用的角色，不含 verify、report、hub_reason 或其他 system/hub 角色。不得用记忆补充角色名。",
    "- 示例：`{}`",
  ].join("\n"),
  list_available_runtime_images: [
    "### `list_available_runtime_images` — 查询 Hub 当前可提案的运行镜像",
    "- 参数：无参数，调用时传空对象 `{}`。",
    "- 时机：Hub 派发 Worker 前调用；返回本项目已启用且存在可信版本的市场镜像 image_key、name、description。",
    "- 边界：intent 的可选字段 `runtime_image_key` 只能原样使用返回的 image_key；省略该字段时平台按角色缺省镜像解析。不得填写 OCI 地址、可变 tag、digest 或目录之外的 key，否则整次决策被拒绝。",
    "- 示例：`{}`",
  ].join("\n"),
  emit_progress: [
    "### `emit_progress` — 上报过程进度",
    "- 参数：`message`（必填，当前动作或阶段结论，1-2000 字符）；`percent`（可选，0-100）。",
    "- 时机：开始关键阶段、获得阶段结论或遇到耗时步骤时调用；可以多次调用，但不要用它提交最终结果。",
    '- 示例：`{"message":"已定位认证入口，正在追踪会话校验链路","percent":35}`',
  ].join("\n"),
  emit_fact: [
    "### `emit_fact` — 增量提交可验证事实",
    "- 直接参数：`title`（至少 2 个非空白字符）；`description`（至少 16 个非空白字符）；`verification`（可选，仅 Hub 回弹补证 Job 接受）。也可只传 `payload_file`，值为 /workspace 下的安全相对路径。",
    "- 长内容或收到 HTTP 错误响应/截断后，先 Write 完整 JSON 到 /workspace，再只传 `payload_file`；禁止用故意缩短的语义内容重试。",
    "- `verification` 字段：`finding_id`、`evidence_kind`（review|test）、`outcome`（supports|refutes|inconclusive）、`subject_revision` 必填；test 还应含 `steps`、`expected`、`actual`（或 artifact_refs）。",
    "- 时机：每得到一个不在画布中的原子事实立即调用；单 Job 最多 100 条。description 写明证据、来源、推理边界和仍未知内容。",
    '- 普通示例：`{"title":"登录接口使用独立限流键","description":"证据：apps/api/login.ts:42 以 IP 生成键；来源：本地源码；未知：反向代理是否覆盖客户端 IP。"}`',
    '- 补证示例：`{"title":"实测复现未授权读取","description":"步骤与响应见 verification","verification":{"finding_id":"<uuid>","evidence_kind":"test","outcome":"supports","subject_revision":"app@abc123","steps":["构造请求","观察响应"],"expected":"拒绝","actual":"返回其他租户数据"}}`',
  ].join("\n"),
  emit_finding: [
    "### `emit_finding` — 增量提交通用 Finding",
    "- 直接参数：`title` 至少 8 个非空白字符、`summary` 至少 32 个非空白字符；severity 只能是 `low|medium|high|critical`。`location`、`rule_id`、`suggest_verify` 可选。也可只传 `payload_file`，值为 /workspace 下的安全相对路径。",
    "- 长内容或收到 HTTP 错误响应/截断后，先 Write 完整 JSON 到 /workspace，再只传 `payload_file`；禁止用故意缩短的语义内容重试。",
    "- 时机：有具体位置、触发路径和证据的安全问题一经确认就调用；单 Job 最多 20 条。一般建议验证时设 `suggest_verify: true`，是否派生由调度器决定。",
    '- 示例：`{"title":"重置令牌可重复使用","severity":"high","location":"src/auth/reset.ts:88","summary":"成功重置后令牌未失效，可再次修改密码。","rule_id":"AUTH-RESET-REPLAY","suggest_verify":true}`',
  ].join("\n"),
  submit_hub_decision: [
    "### `submit_hub_decision` — 提交 Hub 决策",
    "- 参数只能三选一：`complete: {from, description}`，或 `intents: [{from, role, description, prompt}]`，或 `payload_file: \"相对路径\"`（读取 /workspace 下预先 Write 的 JSON）。",
    "- `from` 只能填写本轮画布中的 root/fact/finding id；`role` 只能原样选择本轮 `list_available_roles` 的 name（英文 id）；`description` ≥8 字符；`prompt` ≥32 字符且必须让全新 Worker 可独立执行。",
    '- 多意图或长 prompt 时**必须**用 `payload_file`：先 Write 完整 JSON（根对象含 complete 或 intents），再 `{"payload_file":"hub_decision_payload.json"}`。直接塞大 JSON 可能截断并返回 HTTP 错误响应。',
    "- 成功提交后每个 Job 只能一次；仅当上一次 HTTP 请求失败或参数校验失败时才可重试。不要在成功后为“补全”再次调用；不要与 `request_human` 混用。",
    '- 完成示例：`{"complete":{"from":["<fact-id>"],"description":"目标已由引用证据完整覆盖。"}}`',
    '- 派发示例：`{"intents":[{"from":["<root-id>"],"role":"explore","description":"确认目标材料与版本","prompt":"定位任务目标的权威材料，记录版本、来源和仍缺失的信息；只提交新增事实。"}]}`',
    '- 大 payload 示例：Write `/workspace/hub_decision_payload.json` 后调用 `{"payload_file":"hub_decision_payload.json"}`',
  ].join("\n"),
  mark_job_done: [
    "### `mark_job_done` — 正常结束 Job",
    "- 普通 Worker 参数：`summary`（必填，至少 8 个非空白字符，最多 10000）；不得传 `verdict`。",
    "- verify 参数：`summary` 与 `verdict` 均必填；verdict 只能是 `confirmed|rework|needs_human`（兼容 `false_positive`，服务端映射为 rework）。",
    "- `confirmed` 仍须通过 Scheduler 证据硬门（独立 review + 完整 test）；不满足时会记为 rework 并回弹 Hub。",
    "- `rework` 时建议在 summary 中写明缺失证据；可选 `missing_evidence` 字符串数组。",
    "- 时机：所有增量 fact/finding 已提交且任务确实收尾后只调用一次。Hub 必须先调用 `submit_hub_decision`。",
    '- 普通示例：`{"summary":"完成入口梳理并提交 3 条新增事实；未覆盖移动端客户端。"}`',
    '- verify 示例：`{"summary":"在受影响版本复现未授权读取，响应包含其他租户记录。","verdict":"confirmed"}`',
    '- rework 示例：`{"summary":"缺少运行时复现；仅有同源静态描述。","verdict":"rework","missing_evidence":["runtime_test"]}`',
  ].join("\n"),
  request_human: [
    "### `request_human` — 请求人工介入并结束本轮",
    "- 参数：`reason`（必填，8-2000 字符）与结构化 `subject`（必填）；服务端不会从 reason 推断目标。",
    "- Finding 阻塞：`subject={type:\"finding\",finding_id,subject_revision}`；只允许当前项目、当前画布且未被最低严重度策略豁免的 canonical Finding。",
    "- 平台阻塞：`subject={type:\"platform_blocker\",kind}`；kind 只能是 authorization|credential|high_risk_action|business_decision。",
    "- 调用后停止执行，不再调用 `mark_job_done` 或 `submit_hub_decision`。",
    '- Finding 示例：`{"reason":"需要人工确认风险接受边界和目标版本。","subject":{"type":"finding","finding_id":"<uuid>","subject_revision":"app@abc123"}}`',
    '- 平台阻塞示例：`{"reason":"缺少隔离测试账号，无法继续动态验证。","subject":{"type":"platform_blocker","kind":"credential"}}`',
  ].join("\n"),
  list_shared_assets: [
    "### `list_shared_assets` — 查询本 Job 冻结的只读共享资产目录",
    "- 参数（均可选）：`scope`（platform|project|finding）、`prefix`（逻辑 key 前缀）、`limit`、`offset`。",
    "- **没有单独的下载工具。** 返回的每条资产含 `mount_path` / `read_path`：用普通 Read/cat 直接打开该路径读取内容；需要改写时先 `cp` 到 `/workspace` 普通工作区。",
    `- 字节由 Scheduler 在 Job 启动时从 BlobStore（本地盘或任意 S3 兼容存储）预挂载到 \`${SHARED_ASSETS_READONLY_ROOT}\`；Agent 不得用 HTTP/S3/curl 拉取，也没有对象存储凭据。`,
    "- 时机：需要复用平台/项目/Finding 资产、PoC 脚本或基线材料时先 list 再按路径读取。",
    '- 示例：`{}` 或 `{"scope":"project","prefix":"scripts/","limit":50}`',
  ].join("\n"),
  publish_shared_asset: [
    "### `publish_shared_asset` — 发布工作区文件为不可变共享资产",
    "- 参数：`scope`（project|finding）、`source_path`（必填，必须是 `/workspace/` 下的普通工作文件，不能位于平台运行目录或 CLI 用户/配置目录）、`key`（逻辑路径）、`content_type`、可选 `labels`。",
    "- 时机：产出可被后续 Job 复用的脚本、PoC、基线或工件后调用；Scheduler 读取工作区文件并经 BlobStore 写入（本地或 S3 兼容存储），Agent 不接触存储后端。",
    "- 边界：仅 running Job 可发布；不能覆盖 human/platform key；Finding scope 仅当本 Job 绑定 finding_id。",
    "- 文件类型/格式不限制：任意扩展名与 MIME 均可（未知类型用 application/octet-stream）；仍受路径安全与大小配额约束。",
    '- 示例：`{"scope":"project","source_path":"/workspace/dist/repro.sh","key":"scripts/repro.sh","content_type":"text/x-shellscript"}`',
    '- 二进制/PoC 示例：`{"scope":"finding","source_path":"/workspace/poc/harness","key":"openharmony/poc/harness.bin","content_type":"application/octet-stream"}`',
  ].join("\n"),
  ack_human_message: [
    "### `ack_human_message` — 确认已收到并纳入处理一条人工消息",
    "- 参数：`message_id`（必填，UUID，必须来自注入到本 Job 的人工消息）；`summary`（可选，最多 500 字符，简述如何纳入当前工作）。",
    "- 时机：阅读并纳入该人工消息后调用；平台只有在此 ACK 后才把消息标为「Agent 已确认」。普通文本回复、Session 内容或节点标题都不会被视为确认。",
    "- 边界：只能确认当前 Job 收件箱中的消息；不得猜测 message_id 或确认其他 Job 的消息。每个 message_id 成功 ACK 一次即可。",
    '- 示例：`{"message_id":"<uuid>","summary":"已按补充范围调整探索重点"}`',
  ].join("\n"),
};

/** 生成本 Job 实际授权的平台工具说明；不会向 Worker 展示未授权工具。 */
const PLATFORM_TOOL_CAUTIONS: Record<string, string> = {
  list_available_roles: "注意：Hub 派发前调用，并原样复制返回的角色 name；不得猜测、缩写或使用已禁用及 system 角色。",
  list_available_runtime_images: "注意：Hub 派发前调用，并原样复制返回的 image_key；不得猜测或使用未启用、未准入的镜像，不得填写 OCI 引用。",
  emit_progress: "注意：只用于增量进度，可按需多次调用；不能代替最终结果，仅在 HTTP 请求失败或参数校验失败后修正并重试。",
  emit_fact: "注意：每个新增可验证事实提交一次，禁止用故意缩短的内容重试；遇到 HTTP 错误响应或截断时，写入完整 JSON 后使用 payload_file。",
  emit_finding: "注意：只提交有证据支撑的 Finding；suggest_verify 只是建议，验证是否派生由 Scheduler 决定；遇到 HTTP 错误响应或截断时用 payload_file 提交完整内容。",
  submit_hub_decision: "注意：Hub 在 mark_job_done 前调用，complete、intents、payload_file 必须三选一；成功后只允许一次，仅在 HTTP 请求失败或参数校验失败后重试。",
  mark_job_done: "注意：仅主协调 Agent 在所有子代理结束后调用，子代理不得调用；首次合法 summary 为权威结果，迟到的重复调用会被忽略且不会覆盖，因此只调用一次，成功后不得重试。",
  request_human: "注意：这是终态人工阻塞请求；调用一次后停止，不得再调用 mark_job_done 或 submit_hub_decision，仅在 HTTP 请求失败或参数校验失败后重试。",
  list_shared_assets: "注意：只读取返回的冻结挂载路径；不得修改共享挂载，也不得通过 HTTP、curl 或 S3 另行获取。",
  publish_shared_asset: "注意：只发布普通 /workspace 工作文件；不得发布平台运行目录或 CLI 用户/配置目录中的内容，仅在 HTTP 请求失败或参数校验失败后重试。",
  ack_human_message: "注意：只有显式 ACK 才算已确认；message_id 必须来自注入文本，不得用自然语言替代；仅在 HTTP 请求失败或参数校验失败后重试。",
};

export function platformToolGuide(toolNames: string[]): string {
  const enabled = new Set(toolNames);
  const incremental = ["emit_progress", "emit_fact", "emit_finding"].filter((name) => enabled.has(name));
  return [
    "调用规则：对当前授权 operation，只能使用静态 `deepsonar-control` Skill 所述的 Job-scoped control API，由 Agent 通过自身可用的 HTTP 工具直接调用；Runtime Adapter 只负责驱动 CLI 协议，不会代为发起 HTTP 请求。不得使用其他控制通道、shell 写控制文件或猜测管理路由。API 返回 `accepted` 只表示 Scheduler 已接收输入，仍会重验并记账；收到 HTTP 错误响应或参数校验失败时，修正请求后重试，不得把失败调用当作已上报。",
    `生命周期：${incremental.length > 0 ? `${incremental.map((name) => `\`${name}\``).join("、")} 可增量调用；` : ""}正常完成以一次 \`mark_job_done\` 或 API 对应 operation 结束${enabled.has("request_human") ? "，人工阻塞以一次 `request_human` 结束，二者不要同时调用" : ""}。平台收到事件后负责实时入库、画布更新、派生与终态处理。`,
    ...toolNames.flatMap((name) => [PLATFORM_TOOL_USAGE[name], PLATFORM_TOOL_CAUTIONS[name]]).filter((entry): entry is string => Boolean(entry)),
  ].join("\n\n");
}
