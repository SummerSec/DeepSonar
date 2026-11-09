# 自动沉淀触发与历史补做

用户已要求补齐自动触发、接入 Barry 全局 Skill 源，并检查已运行任务。实现使用现有 Scheduler、知识 work、独立标准 Job、CAS 和评测审查，不修改历史 Job 快照，不以整理请求表示知识已经激活。

## 任务收尾

普通业务 Job 与最新 Attempt 成功结算后，在现有终态事务中的独立 savepoint 内登记一个知识 work。固定 trigger key 绑定来源 Job，已有该 Job 的整理链则复用；重复回调、重启和补做不能创建新的预算链。Hub、Report、知识治理及 trial Job 排除，避免自触发。

新知识画布保留来源Job冻结的allow_egress，缺失时关闭，不能继承更宽的项目默认网络策略。来源 Job 必须具有冻结的 request_project_knowledge 权限，项目仍有效，最新 Attempt 成功且不存在未结算的 effect_pending/unknown 外部效果。失败、孤儿、人工等待和已归档项目不自动整理。知识登记失败不得回滚主任务结算，保留脱敏错误日志，可由补做入口重查。

新 work 使用现有 pending 状态和明确的待准备 reason。Dispatcher 在领取知识 work 前准备输入；未准备 work 不能交给 maker。仅选择该 Job 自己的 Fact/Evidence，最多20项，每项遵守现有12KiB上限，沿用 resolve/recheckKnowledgeSource 和 origin Job 的冻结治理方法。CAS 写在短事务外，注册元数据和完成输入冻结在短事务内。无来源记录为 completed 且 reason 明确为跳过，不产生模型 Job。来源拒绝/撤销为 blocked；不伪造质量、usage 或 accepted 回执。继续使用32 Jobs、1800秒、两次修订的现有上限。

## 管理补做

项目范围的管理 API 提供分页只读预览和最多5个精确 Job ID 的显式补做，分别要求 projects:read / projects:write。返回可补做、已有work、无来源及具体不可执行原因；写入走同一登记函数和 Canvas→Job→work锁序。拒绝跨项目、未知字段、重复ID和非法批量。不得恢复历史执行 token、重绑 Attempt、覆盖历史记录或直接激活候选。

## 全局 Git Skill 源

用户于2026-11-09明确选择公开 Barry04/deepsonar-global-skills，使用已有匿名 HTTPS 同步机制接入，不新增凭据能力或修改凭据metadata。仓库已公开，运行平台已核对23模块并将源审批为trusted+enabled。新Job冻结目录已包含该源，进行中Job不换源。任务沉淀仍只写项目治理存储，不自动回写GitHub。

## 验收

覆盖成功触发、重复/并发/手工请求去重、无来源跳过、未获准和跨项目拒绝、知识自身不递归、终态主事务不受失败影响、异步准备/CAS/重启、撤权与未知效果停止。行为、契约、文档及typecheck只在GitHub Actions执行；本地只做diff检查及运行平台只读/已授权管理操作。独立评审最终diff，CI通过不自动授权合并或发版。
