# #775 冻结离线控制回放

> 状态：as-built 控制行为回归切片；不是模型质量实验，也不是 C 阶段改善证据。
> 同步日期：2026-10-30

基线为已验证 #809 `ffb30d912b103d889430e2b56627730f956265d7` 的真实 SQL/HTTP 夹具行为。`baseline.json` 固定 16 个场景和预期值；单元测试另锁文件 SHA，修改 oracle 必须显式审阅。inline/file 是输入方式，不是前后模型实验臂。样本全部合成，没有生产或真实模型调用。

先安装并构建工作区，再配置隔离 `TEST_DATABASE_URL`（测试自行创建/删除独立数据库）：

```sh
pnpm ci:unit:plan-replay
pnpm ci:integration:plan-replay
```

运行器调用既有 `plan-decision.integration.test.ts`，从实际 Control 响应、投影和 SQL 状态记录 32 个观测；不会将 baseline 的 expected 写成 observed。执行结果位于忽略追踪的 `artifacts/plan-replay/report.json`，CI 上传为 `plan-offline-replay`。失败也尽可能生成缺失/差异报告；未运行或跳过 DB 不能通过。普通 Plan 测试未设置输出变量时不写报告。先写实际观测再做预期断言，因此失败值保留为 different，后续未执行场景保持 missing。集成入口先在隔离夹具中故意省略无证据完成预检，使实际响应变为200并验证回放失败、首项different和其余31项missing，再运行无故障正向回放。负例证据保存为 negative-regression.json，外层 regression_passed 表示成功检测故障，不表示内部失败报告通过。故障开关仅存在于测试handler，生产代码不消费它。

每行保留 mode、case ID、expected、observed、match/different/missing。另列故意无证据完成提案的实际接纳/拒绝数和显式人工请求后的 waiting_human 数及各自分母；这不是模型犯错率或自然人工介入率。总分母与分类分母均列 expected/observed/matched/different/missing，重复和额外 ID 独立使运行失败；不能缩小分母掩盖缺失。报告绑定基线 commit/文件 SHA、当前 HEAD、dirty 标记、子进程退出码和整套夹具耗时。耗时包括数据库准备与测试，不是模型时间，也不用于收益门禁。

| 样本组 | 每输入方式的场景数 | 测量边界 |
| --- | ---: | --- |
| 无证据完成声明 | 1 | 实际完成拒绝响应，不测模型犯错率 |
| 仅接纳未派发 | 1 | 实际 child 数及补证投影 |
| 生命周期与矛盾状态 | 10 | 受控 Job/Attempt fixture，不认证外部环境 |
| 凭据阻塞报告 | 1 | Agent 类别与 authority，不认证凭据不可用 |
| 历史未知效果 | 1 | 新执行成功不得隐藏旧 unknown |
| 执行证据不等于判据满足 | 1 | 实际留存字节/Fact 后仍 unbound |
| 安全人工停止 | 1 | 接纳、人工作业状态及一次 child 数 |

## 尚未测量与后续必需项

`semantic_goal_omissions`、`model_quality`、`model_tokens`、`model_time` 和 `adaptive_no_progress_rounds` 固定为 null/not_measured，不能报零、计算改善比例或开启 C。真实模型验收按用户要求豁免，但不能把控制回归当质量收益。

原 #775 的正/阴性语义充分性、完整判据覆盖、真实环境原因认证、改变方法/多轮无进展、目标修订及依赖调度仍需后续离线纵向切片与各自 oracle。已有 #800 正向评审/绑定测试继续由完整 Plan 集成套件执行，但未列入这 32 行的分母，不冒称全部验收样本。本片只建立可审查的固定回归基线及逐例差异设施，不替代原 issue 的全部对照验收。
