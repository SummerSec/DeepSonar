# 项目知识积累与复用闭环

> 状态：实施设计；用户已明确要求先修真实闭环，再接项目自动整理与可见效果。
> 同步日期：2026-11-11

## 目标与现状

本机 0.6.19 的只读排查发现：24 条来源登记、1 个 blocked work、1 条未激活 Memory、0 个项目 Skill、0 条 usage。首个 trial 发布成功却未取得版本 UUID，误将操作 ID 用作 Evidence URI；without 组缺少共同任务材料。这些是本轮修复依据，不是模型效果验证。

交付现有 Scheduler/Job/Attempt/Control 路径中的来源收集、候选评测激活、后续精确版本读取和反馈。不得建立第二执行器、绕过独立审查、改写历史 work/Job、重置耗尽预算或伪造效果。

## 模块与职责（已核对）

- `deepsonar:scheduler-runtime`：`executor-real.ts` 的共享资产发布与真实工具响应；需返回持久资产版本/hash。
- `deepsonar:project-knowledge`：`automatic.ts` 登记、`work.ts` 调度、`recovery.ts` 结算、catalog/usage/feedback。新增项目来源批次收集，复用 work 和 CAS；不增加 schema。
- `deepsonar:shared-types`：知识操作/assignment 的机器契约；保留权限和固定安全用例，审查输入隔离。
- `deepsonar:web`：项目知识管理投影；展示来源、候选、生效、读取、反馈与阻塞。
- `deepsonar:management`：`auth.ts`、OpenAPI、route manifest 和管理 Skill 文档同步新增只读 activity 接口。

## 决定

1. 发布工具返回真实资产 ID、版本 UUID 和内容 hash；相同幂等提交查询原结果，禁止重复制造资产。失败保持既有错误/未知效果语义。
2. 每个 evaluation case 以 `task_inputs` 明确选择冻结的原始任务材料，各 arm 只差 baseline/candidate；不得自动复制含结论的全部来源。空材料仅适用于 prompt 自带输入的用例。trial 不收到 expected、评分 rubric、业务 RoleConfig 指令或 governance recipe；评分 rubric 与完整评测结果仅供 evaluator/reviewer 精确读取。审查须检查共同材料没有泄漏答案。对照组 target 可产生有证据的 fail，目标 arm（create/revise/merge 为 candidate，retire 为 without）target 与全部安全 case×arm 必须 pass；unexecuted 不能结算。此处允许基线失败用于比较，不放宽安全门。
3. 项目收集由 Dispatcher tick 调用，采用现有来源审计、CAS 和 `project_knowledge_work`。每项目同一时间最多一个待处理/运行 work；每批最多 4 个来源 Job、19 个原始输入及可选 governor，完整冻结所选 Job 的来源。超过单次边界、已撤销、来源缺失等明确记录跳过原因，不静默截断。批次内容准备在事务外，统一项目锁内重核权限、来源与已消费记录，原子创建 work 与逐来源 `project_knowledge.source_collected`；审计绑定登记 ID、Attempt、work、manifest hash。跨实例/重启只消费一次，包括 blocked/cancelled work，不能改变批次组合刷预算。登记仅唤醒既有 Dispatcher，启动后也从审计恢复待收集来源，不在终态事务中做模型或文件 IO。跳过原因保留且不自动重试，避免坏来源热循环；后续需要显式治理恢复，不伪造已处理成功。
4. 新批次与历史 `knowledge:auto:` work 分开；旧冻结记录不改写，未知效果、blocked、耗尽预算不自动复活。收集只消费已登记的成功来源，不偷偷给全部旧任务回填登记。项目归档和来源冻结 allowlist 继续 fail closed。自动批次只使用冻结资料，禁止扩大原任务外部执行授权。
5. 不增加预算或降低 6 类独立 case×arm 评测/审查门。保留现有累计 Job/时间/修订限制，接纳每次提案前预留完整 trial 加 evaluator/reviewer 两个 Job；最多两次修订仍受剩余累计额度约束。显示阻塞原因和实际消耗。效果按真实读取与有证据的反馈呈现，不能从条目数推导质量收益。
6. `GET /projects/:id/knowledge/activity` 提供项目范围只读摘要与分页 work 进度，明确区分登记、已纳入整理、跳过、草稿、生效、读取与模型报告的反馈。复用现有刷新，不新增通知和后台轮询。

## 注意力成本

用户无需每次手工要求收集或猜测空目录原因；项目页集中呈现积累与阻塞并链接现有 Job/Canvas。新增成本为少量摘要与按需展开的运行详情，无额外审批页面、通知或配置。效果收益未测量。

## 验收

- 真实 Control 工具响应能取得资产版本/hash；同 key 重试保留原结果，权限/取消/未知效果不绕过。
- PostgreSQL 回归覆盖来源登记→项目批次→maker/trial/evaluator/reviewer→active→新 Job 精确读取→usage/反馈；明确这是工程替身证据，不能称真实模型收益。
- 覆盖并发/重启去重、归档/跨项目/撤权、过大输入、坏 hash、无来源、历史自动 work 不复活、已阻塞批次不重建刷预算。
- activity API 的权限、分页、来源正文不泄漏、真实统计与 UI 迟到响应隔离。
- 测试/构建/typecheck 仅 GitHub Actions；最终候选完整适用检查通过后才称工程验收。生产部署、发版和真实模型收益另记。
