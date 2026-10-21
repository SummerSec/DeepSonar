# #752 真实模型闭环准备入口

状态：可复跑驱动已准备；只运行了离线计划和本地回环限流测试，**未执行真实模型闭环**。本目录不属于固定响应授权烟测，也不向普通 CI 发起付费调用。

## 必要输入

用户只需确定 Provider、精确模型 ID、总费用上限（币种 USD 或先明确换算）与最多模型请求次数；若使用兼容端点，再提供其服务地址。使用独立限额的测试 API key，通过隔离实例的 Credential 管理入口注入，不把密钥发到聊天、配置 JSON、命令行参数或 Git。本环境仅核查变量存在性：未发现 `TEST_DATABASE_URL`、`OPEN_SANDBOX_API_KEY`、`DEEPSONAR_MASTER_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`KNOWLEDGE_LIVE_API_TOKEN`，根 `.env` 不存在。

工程侧准备独立空白 Linux Docker 主机、不可变已准入 runtime digest、OpenSandbox 和 PostgreSQL；不得复用生产宿主机、数据或密钥。数据库名称必须为 `deepsonar_knowledge_live_<suffix>`，数据库与 Scheduler API 均在回环地址。按当前 schema 初始化并配置角色/运行时/模型，但不创建业务项目或任务。Scheduler 与驱动须使用同一隔离数据库；运行前由操作者核对进程启动配置，驱动不读取生产配置或替你迁移数据库。

## 费用与次数边界

- **账单硬上限必须由 Provider 的独立测试项目/key 配额实现。** 本工具不能验证 Provider 的财务设置，`providerHardLimitUsd` 是操作者核实后的声明。Provider 若不能提供硬上限，本轮仍只能准备，不能承诺费用不会超限。
- `budget-relay.mjs` 限制全链路实际发出的模型请求数、单请求输入字节与输出 token 上限，限定模型和三类推理端点。未知路径、重定向、超限一律拒绝，不后台重试、不伪造模型回答。
- 每次请求先同步持久化预算 reservation，再发上游。连接失败/响应不确定也消耗次数与预留额度，重启不退款；同一 journal 并发启动失败。崩溃留下 `.lock` 时先确认旧进程已退出，再人工移除锁；不可删除 journal 重置预算。
- `reserveUsdPerRequest` 是按选定模型最高输入/输出/缓存费率及请求上界核算的保守预留，**不是实收账单**。实际账单以 Provider 为准。请求数硬门与 Provider 硬限额同时生效；不能只靠用量上报后的轮询实现费用承诺。
- 所有活动模型 Credential 的 `public_metadata_json.base_url` 必须指向回环 relay，Driver 会检查这一非秘密元数据。只允许本次测试模型；Provider 密钥仍由 Scheduler 加密保存并经现有 Model Gateway 在宿主发送，relay 不存储请求/响应正文或 header。
- 设置 Scheduler 的 `DEEPSONAR_JOB_TOKEN_MAX_REQUESTS` 与配置中的 `requestsPerJob` 一致。每条治理链原有 32 Jobs/1800 秒/2 次修订限制保留。驱动观察到总 Job 数、运行时间或失败超限时停止 relay 并调用已有取消 API；Job 数轮询不是瞬时硬配额，实际付费请求由 relay 拦截。

## 可复跑命令

复制 `config.example.json` 至隔离运行目录，填写已授权模型、预算和非秘密配置；模板预算为 0，不能直接付费运行。`upstream` 使用 Provider HTTPS origin，`relay` 不加 `/v1` 后缀。

只查看计划（不连接 API/数据库，不读密钥，不调用模型）：

```sh
node agent-harness/knowledge-live/run.mjs /path/to/config.json
node --test agent-harness/knowledge-live/budget-relay.test.mjs
```

仅在用户已确认预算、Provider 硬限额和环境已就绪后，由运行器安全注入 `KNOWLEDGE_LIVE_APPROVED=yes`、独立 `TEST_DATABASE_URL` 与短期 `KNOWLEDGE_LIVE_API_TOKEN`；不要把实际值放进命令历史。两个进程分别运行：

```sh
node agent-harness/knowledge-live/budget-relay.mjs /path/to/config.json
node agent-harness/knowledge-live/run.mjs /path/to/config.json --run
```

驱动以普通管理 API 创建测试项目和任务 A。A 用真实 Fact/Evidence 请求知识整理；maker、12 个 case×arm trial、evaluator、reviewer 由现有 Scheduler 组织。没有直接数据库写入、自批、合成评测结果或预激活版本。

首次激活后 Driver 保存 report 并退出，状态为 `awaiting_scheduler_restart`。保存 Scheduler PID/容器 ID、启动时间和关闭日志；只重启该隔离 Scheduler，确认数据库与 journal 保留，再运行：

```sh
node agent-harness/knowledge-live/run.mjs /path/to/config.json --run --resume
```

任务 B 精确读取 A 的 Skill，在 Unicode 空白输入上实际验证 ASCII 方法边界，提交真实失败证据和 usage 反馈；后续链必须修订同一身份并重新独立评测/审查。若模型选择不同方法或无法产生真实失败，验收应失败或阻塞，不能捏造证据或手工改 active 指针。

## 判定标准

成功必须同时满足：

1. A 的候选有来源；独立 case×arm trial 的 Job/Attempt、CAS 证据齐全；evaluator/reviewer 与 maker 不同 Job，绑定同一 proposal revision/input digest；平台硬门自动激活。
2. 重启前后保持 work/proposal/receipt/版本身份；没有重复 Job、重复激活或未知效果重放。Driver 的 `--resume` **不证明进程真的重启**，需另核对上述进程记录。故自动报告最多为 `lifecycle_passed_restart_unverified`，不能直接当作完整验收通过。
3. B 实际搜索/拉取精确版本，有 usage、真实失败 Evidence 和 `record_knowledge_feedback` receipt；反馈驱动同一身份的后续版本，旧版本与来源不可变。
4. 所有 Job 成功、无 blocked/orphan、用量已结算；保存 commit、镜像 digest、模型/治理 hash、case/输入 hash、Job/Attempt/Receipt/Evidence、token 与实际 Provider 账单；清理没有遗留沙箱或短期 token。
5. 此闭环之外，跨项目拒绝、撤销、旧字节冻结、自批拒绝、无评测新建、满分越权、预算耗尽、取消和故障恢复仍按既有数据库/真实授权烟测逐项复验；本 Driver 不将单条成功路径冒充全部安全验收。

任何模型/预算/传输/证据错误都退出非零并停止 relay；没有生产状态 fallback。Driver 只查询受限证据列，不导出原始 Provider 报文、密钥或全量 Session。报告保留测试记录，不自动删除数据库；清理通过既有 Scheduler 取消/销毁和隔离环境撤除执行。无人工批准知识内容入口。
