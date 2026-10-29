# 白盒任务检查

> 状态：任务设计指南；机器字段与模板版本由共享 TaskContract 定义。
> 同步日期：2026-10-29

先用[共用下发检查](task-dispatch.md)，选择 `whitebox`；灰盒选择 `graybox` 并组合[黑盒边界](blackbox-checklist.md)。

- 写清源码来源、确定基线、相关模块和已有材料引用。`baseline` 缺失会提示；填写提交号本身不证明源码已可访问。
- 静态审查的范围与动态验证条件分开。构建/测试入口放在任务正文或前置条件说明中；不可用时报告限制，不能虚构环境。
- 以源码位置、路径与证据引用验收，不要求创建前已证明 source→sink，也不承诺任意样本必然产生 confirmed finding。
- 列出停止条件：越界文件/资产、权限缺失、预算耗尽、未知副作用；不以扩大扫描范围补偿材料不足。

可从 Web 的白盒模板开始，填 `objective/targets/baseline/scope/exclusions/stop_conditions/acceptance/evidence/budget`，明确 `required_actions`。例如本地静态审查可声明 read、禁止 write/egress；验收是“报告指定基线的观察、证据和未验证限制”。构建或修改沙箱缓存时据实声明 `workspace_write`；访问/修改外部目标需要额外 `egress`/`write` 并受实际边界约束，不能把执行测试默认为只读。

必要构建环境可写入 `prerequisites`，状态只能是 declared、missing 或 not_applicable。required=true 的条件若没有当前可信核验会阻塞；若动态环境不属于本次目标，应明确改为静态任务，而不是把缺环境写为已验证。
