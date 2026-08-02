const PLATFORM_TOOL_USAGE: Record<string, string> = {
  list_available_roles: [
    "### `list_available_roles` — 查询 Hub 当前可派发角色",
    "- 参数：无参数，调用时传空对象 `{}`。",
    "- 时机：Hub 判断需要派发 Worker 时先调用；返回本 Job 从数据库冻结的角色 name、title、description。只允许原样使用返回的 name。",
    "- 边界：结果只含 `kind=role` 且当前项目启用的角色，不含 verify、report、hub_reason 或其他 system/hub 角色。不得用记忆补充角色名。",
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
    "- 参数：`title`（必填，1-200 字符）；`description`（必填，1-10000 字符）；`verification`（可选，仅 Hub 回弹补证 Job 接受）。",
    "- `verification` 字段：`finding_id`、`evidence_kind`（review|test）、`outcome`（supports|refutes|inconclusive）、`subject_revision` 必填；test 还应含 `steps`、`expected`、`actual`（或 artifact_refs）。",
    "- 时机：每得到一个不在画布中的原子事实立即调用；单 Job 最多 100 条。description 写明证据、来源、推理边界和仍未知内容。",
    '- 普通示例：`{"title":"登录接口使用独立限流键","description":"证据：apps/api/login.ts:42 以 IP 生成键；来源：本地源码；未知：反向代理是否覆盖客户端 IP。"}`',
    '- 补证示例：`{"title":"实测复现未授权读取","description":"步骤与响应见 verification","verification":{"finding_id":"<uuid>","evidence_kind":"test","outcome":"supports","subject_revision":"app@abc123","steps":["构造请求","观察响应"],"expected":"拒绝","actual":"返回其他租户数据"}}`',
  ].join("\n"),
  emit_finding: [
    "### `emit_finding` — 增量提交安全 Finding",
    "- 参数：`title`、`severity` 必填；severity 只能是 `low|medium|high|critical`。`location`、`summary`、`rule_id`、`suggest_verify` 可选。",
    "- 时机：有具体位置、触发路径和证据的安全问题一经确认就调用；单 Job 最多 20 条。一般建议验证时设 `suggest_verify: true`，是否派生由调度器决定。",
    '- 示例：`{"title":"重置令牌可重复使用","severity":"high","location":"src/auth/reset.ts:88","summary":"成功重置后令牌未失效，可再次修改密码。","rule_id":"AUTH-RESET-REPLAY","suggest_verify":true}`',
  ].join("\n"),
  submit_hub_decision: [
    "### `submit_hub_decision` — 提交 Hub 决策",
    "- 参数只能二选一：`complete: {from, description}`，或 `intents: [{from, role, description, prompt}]`；每个 Hub Job 只调用一次。",
    "- `from` 只能填写本轮画布中的 root/fact/finding id；`role` 只能原样选择本轮 `list_available_roles` 的返回值；`prompt` 必须让全新 Worker 可独立执行。",
    '- 完成示例：`{"complete":{"from":["<fact-id>"],"description":"目标已由引用证据完整覆盖。"}}`',
    '- 派发示例：`{"intents":[{"from":["<root-id>"],"role":"explore","description":"确认目标材料与版本","prompt":"定位任务目标的权威材料，记录版本、来源和仍缺失的信息；只提交新增事实。"}]}`',
  ].join("\n"),
  mark_job_done: [
    "### `mark_job_done` — 正常结束 Job",
    "- 普通 Worker 参数：`summary`（必填，1-10000 字符）；不得传 `verdict`。",
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
    "- 参数：`reason`（必填，1-2000 字符），必须说明阻塞点、已完成工作和需要人工提供的具体内容或授权。",
    "- 只在缺少必要授权/凭据、必须操作生产环境或动作风险超出任务授权时调用。调用后停止执行，不再调用 `mark_job_done`。",
    '- 示例：`{"reason":"验证需要生产租户的只读测试账号；已完成静态路径确认，请人工提供隔离账号或批准在测试环境复现。"}`',
  ].join("\n"),
};

/** 生成本 Job 实际授权的平台工具说明；不会向 Worker 展示未授权工具。 */
export function platformToolGuide(toolNames: string[]): string {
  const enabled = new Set(toolNames);
  const incremental = ["emit_progress", "emit_fact", "emit_finding"].filter((name) => enabled.has(name));
  return [
    "调用规则：直接调用当前 Agent CLI 工具列表中的同名 MCP 工具，并传入 JSON 对象；不要用 shell、curl 或手写 `.deepsonar/control-events.jsonl` 代替工具调用；只用普通文本描述决策、发现或摘要同样不算提交。成功响应会返回 `accepted event <id>`；收到 `isError` 时修正参数后重试，不得把失败调用当作已上报。",
    `生命周期：${incremental.length > 0 ? `${incremental.map((name) => `\`${name}\``).join("、")} 可增量调用；` : ""}正常完成以一次 \`mark_job_done\` 结束${enabled.has("request_human") ? "，人工阻塞以一次 `request_human` 结束，二者不要同时调用" : ""}。平台收到事件后负责实时入库、画布更新、派生与终态处理。`,
    ...toolNames.map((name) => PLATFORM_TOOL_USAGE[name]).filter((entry): entry is string => Boolean(entry)),
  ].join("\n\n");
}
