# 任务设计与下发

> 状态：as-built（#767 的结构化任务契约与准入边界）；真实模型质量收益未评测。
> 同步日期：2026-10-29

目标是让不同创建者明确可执行、可验收的共同底线，按场景适配；不要求相同措辞、固定 Markdown 标题或必然产生漏洞。下发前先读运行中的 OpenAPI，再选择[白盒](whitebox-checklist.md)、[黑盒/灰盒](blackbox-checklist.md)或工程任务。场景模板和版本的唯一机器来源是 [TaskContract](../../../packages/shared-types/src/task-contract.ts)；文档示例不是另一份自动填值来源。

## 共用检查

明确目标与交付、目标资产及基线/环境、范围和排除项、假设/依赖、材料及凭据引用、允许/禁止动作与停止条件、证据和完成标准、时间/步骤预算。未知项写明未知，不能补成已确认；账号密码、token、cookie 不进入契约或任务正文。已有项目上下文应引用事实来源，不能从项目名称推断授权。

按可独立验收的目标、共同前置条件和预算拆分。必要的创建→保存→发布→触发状态链保持连贯；彼此无关的目标可分开并在任务正文写明依赖。范围过大与预算冲突提示需要人工判断，字段数量检查不能理解任意自然语言。

## 可选契约与反馈

`POST /projects/:id/tasks` 保留 `title/content`，可另提交 `task_contract`。Web 的可选契约编辑器与管理 CLI `tasks create --task-contract @contract.json` 走相同 API。未提供契约时继续接受自由文本并返回 `task_contract_not_assessed`；这不等于完成了前置条件检查。

契约必须声明 `schema_version: 1`、`template_id`（engineering/whitebox/blackbox/graybox）和 `template_version: 1`。共享 schema 严格拒绝未知字段/版本/类型和重复前置条件 ID；空白裁剪、集合排序/去重不分析原始需求。缺少非安全信息返回 `task_contract_warnings`，每项含 `code/path/message/suggestion`。创建前已知安全阻塞返回 `409 task_contract_blocked` 与 `task_contract_blockers`，不创建任务。无阻塞时返回 201；不要因为 warning 重复创建。

Canvas 保存规范化契约和模板版本，Job 保存冻结契约用于执行提示；模板更新不改旧任务。预算字段用于规划与提醒，不替代平台运行预算。验收文本由创建者确认，模板建议不会自动变成已承诺结果。

## 派发前的可信边界

Scheduler 在沙箱创建前再次核对当前项目网络策略、引用凭据的存在/启用/项目范围与冻结 Job 边界。客户端 `allowed_actions` 只是本次限制，不能授予写权限或出网。显式契约任务的出网取当前项目规则、冻结 Job 网络与契约允许动作的交集；即使任务请求 `allow_egress: true`，也不能绕过当前项目规则。未选择 egress 的契约会冻结为禁止出网；旧的无契约任务保留原网络覆盖语义。`identity` 是待核验的目标租户/角色/资源声明；凭据存在不证明已登录目标，也不证明有目标写权限。前置条件只能声明 `declared/missing/not_applicable`，不能提交 `verified`。

当前没有通用目标身份/写授权/材料可达性的可信探测器：必要身份、write 或必需前置条件无法核验时拒绝依赖链，返回具体补充项。不会为了探测权限尝试未授权写入。只读任务可明确声明 read；需要目标外联时另声明 egress，仍受实际项目/Job 策略限制。无法安全自动拆分任意自由文本，因此阻塞整条契约依赖链；要保留只读价值，应另建明确范围的只读任务，不能把动态验证目标标成已完成。

这是一道任务准入门，不是对沙箱任意命令的细粒度读写授权器。未声明或与正文矛盾的动作需要人工审核；字段检查不证明所有模型行为安全，也不取代现有平台准入。

## 工程任务示例

以下示例仅做本地只读检查。修改沙箱工作区文件/测试缓存可声明 `workspace_write`，仍需 Scheduler 当前授权；它不包含推送代码、发布或修改外部业务资产，后者应声明 `write` 并经目标授权核验。

```json
{
  "schema_version": 1,
  "template_id": "engineering",
  "template_version": 1,
  "objective": "分析测试失败原因并交付修复建议",
  "targets": ["已挂载的项目源码"],
  "scope": ["相关模块和失败测试"],
  "exclusions": ["不修改文件，不部署，不访问外部目标"],
  "stop_conditions": ["所需材料不可访问或超出预算时停止并说明限制"],
  "allowed_actions": ["read"],
  "required_actions": ["read"],
  "forbidden_actions": ["write", "egress"],
  "acceptance": ["列出复现前提、相关代码证据和建议；未复现时说明限制"],
  "evidence": ["源码位置和已有测试日志引用"],
  "budget": {"max_minutes": 30, "max_steps": 20}
}
```

不要把任务本身“寻找根因”误设为创建前必须已证明的前置条件。构建、运行测试可能写沙箱缓存，应按需声明 `workspace_write`；涉及外部业务副作用则还需 `write`，不能自动归类 read。

## 失败后重新下发

先核对失败阶段、已有副作用与产物，再决定是否重新下发；`rerun-current` 会重新冻结配置，不能视为无副作用事务重试。

| 现象 | 重下发前需要确认 |
| --- | --- |
| `PI_RPC_MESSAGE_TOO_LARGE` | 输出路径已修复或有有效缓解；运行时修复归 #765，不机械原样重跑 |
| `ENOSPC` | 空间已恢复，产物完整性与副作用已对账 |
| OpenSandbox 500 | 诊断具体原因，不默认删除 sandbox |
| `40P01` | 确定失败事务和外部效果；事务重试不等于 Job 可重跑 |
| 429 | 区分临时限流与额度耗尽，遵守等待提示和预算 |
| 未提交完成回执 | 可能已完成或部分完成，先对账，不只补一句完成标准 |
| 401/403/scope | 区分过期凭据、错误身份、范围不匹配和禁止；补齐条件须真实授权，不自动提权 |
