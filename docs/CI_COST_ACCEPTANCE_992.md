# CI 路由、失败重跑与成本验收（#992）

> 状态：原 issue 主体的路由/五片隔离已实现；本次依赖审计与成本观测补丁待最终 SHA Actions。受控故障与同 SHA 原生失败重跑已通过，三组文档路径对照正在取证。PR→main 跨提交证据复用未实现、未启用。
> 同步日期：2026-11-08

对应 [NFR-OPS-003](architecture/01-system-specification.md#nfr-ops-003-发布与文档保鲜)；规范归属为[工程规格](architecture/11-engineering-specs.md#4-测试分层与实际接线)。本片承接已落地的 #972/#976，不重复宣称从零拆片或路由；不涉及 #990、生产、真实模型、合并或发布。

## 1. 路由与真实消费边界

唯一计划仍是 [ci-run-plan.mjs](../agent-harness/ci-run-plan.mjs)，只有仓库变量 `CI_PR_MODE` 精确为 `tiered` 才细分 PR；未设置、非法值或 `full` 保留完整 PR 验收。`push@main` 和手动运行不进入 PR 快路。仓库变量实查为 `tiered`（2026-11-07），不是根据耗时猜测。

[Reverse 计划](../agent-harness/reverse-suite-plan.mjs) 与[工作流](../.github/workflows/reverse-runtime.yml)按实际输入区分：

| 改动 | tiered Ready PR 的 Reverse 原生套件 | 原因 |
| --- | --- | --- |
| 共享 [base Dockerfile](../deploy/Dockerfile.agent)、其 COPY 输入、锁文件、workspace/compiler 配置、runtime-sandbox、路由/汇总代码 | 三套全部 | 共享构建或执行输入 |
| [Reverse Dockerfile](../deploy/Dockerfile.agent-reverse) | `reverse` | Claude/Pi-OM 只使用 base，不构建 Reverse 派生镜像 |
| 逐项核对的 Chrome/Kali/Mobile/OpenHarmony 子镜像 Dockerfile | 无 | 不被本工作流构建；精确清单见计划中的 `REVERSE_UNRELATED_IMAGE_INPUTS` |
| 新的未知 Dockerfile、删除/重命名/复制、解析失败、缺失输入 | 三套全部 | 未证明无关，不扩大豁免 |
| REA/Claude/Pi-OM 的独立行为输入 | 对应套件 | 原 #976 的显式清单保留，混合变更取并集 |

宽 `deploy/Dockerfile.agent*` 触发过滤保留，其他镜像改动仍启动轻量 plan/acceptance，但不分配三套重活 runner；这些跳过不豁免核心完整 CI 或对应镜像专项。路由文件自身修改仍全跑。

审计还修正两个漏检方向：[DSH installer](../agent-harness/dsh-request-budget-install.mjs)是 base 的直接 COPY 输入，现补入 shared 和 PR/main 触发；[OM 治理代码](../agent-harness/pi-observational-memory-governed.ts)也被 base COPY，不能继续只算 Pi-OM 私有输入。[回归](../agent-harness/reverse-suite-plan.test.mjs)直接枚举当前 base COPY 源并核对共享计划/双事件触发，未知 COPY/ADD 语法要求重新审查，不静默猜测。

[精确文档分类器](../agent-harness/classify-ci-changes.mjs)修复 #994 的 [CHANGELOG](../CHANGELOG.md) + [Pi RPC 文档](PI_RPC_PAYLOAD_LIMITS.md)两文件形状，不放开整个 docs 目录。Draft→Ready 同 SHA、混合变更、未知路径、缺 SHA、删除/改名和非法配置均有联动反例。

## 2. 五个失败域与原生重跑

[五片清单](../agent-harness/gate-shards.mjs)和[覆盖回归](../agent-harness/gate-shards.test.mjs)保证原套件恰好归属一次。五片均只依赖 `changes`，各自 install/typecheck/build；两个 DB 分片各有独立 PostgreSQL，端口/同库敏感 E2E 留在同一片。不新增跨分片共享工作目录、数据库或准备产物依赖。

[受控运行 42387980272](https://github.com/SummerSec/DeepSonar/actions/runs/42387980272)使用提交 `5a84069eca5cc5f8832f8f0dea08dddbad230e51` 的现有 `isolation_probe`：

- attempt 1 的 [gate-runtime](https://github.com/SummerSec/DeepSonar/actions/runs/42387980272/job/128449370172)先完成真实套件，再在末尾探针故意失败。
- `gate-contract`、`gate-db-core`、`gate-db-domain`、`gate-e2e` 均成功；[ci-summary](https://github.com/SummerSec/DeepSonar/actions/runs/42387980272/job/128451242526)因 runtime 失败而失败。
- attempt 2 已成功：[gate-runtime](https://github.com/SummerSec/DeepSonar/actions/runs/42387980272/job/128452269913)重新执行 296 秒（15:58:46–16:03:42 UTC），[ci-summary](https://github.com/SummerSec/DeepSonar/actions/runs/42387980272/job/128453503654)重新核验并成功。另四片沿用第一轮 runner/步骤与 15:46–15:54 UTC 的执行时间，没有再次执行；本次新增 runner 成本为 runtime 296 秒 + summary 3 秒，不能累加保留结果的旧时长。

操作入口（不是任意 step 续跑）：

```bash
gh run rerun RUN_ID --repo SummerSec/DeepSonar --failed
gh run rerun RUN_ID --repo SummerSec/DeepSonar --job JOB_DATABASE_ID
```

GitHub 会为保留的成功结果生成**新的 job ID / run_attempt**，但沿用旧执行时间和 runner；不能用 job ID 是否变化判定重跑。必须比较各 attempt API 的 runner、步骤与实际时间。单 job 重跑会重新执行该 job 的整段步骤，并可能重跑必要下游；`ci-summary` 必须重新核验，不手工创建成功 check。

## 3. 成本观测口径

[只读观测器](../agent-harness/ci-run-cost.mjs)接入核心/Reverse 的既有汇总 job，不另建重试系统。汇总只增加 job 级 `contents: read` / `actions: read`，不传入长期 secret，不下载或执行其他 run 的 artifact，不改变原 `needs` 结果检查。观测回归在 always-running `docs-freshness` 执行。

- 精确读取 `runs/{id}/attempts/{attempt}` 及分页 jobs，核验 repository/run/attempt、总数和重复 ID。
- `queue_ms` 是 job `created_at → started_at`；此前的 `pre_job_ms` 包括 needs/调度评估，不冒充 runner 排队或额度瓶颈。
- 墙钟为当前 attempt `run_started_at → 最后一个 job completed_at`；runner-minutes 为本次实际执行时长之和，不是 GitHub 取整/加权账单。
- 单列 setup、workspace typecheck/build 与 artifact 上传/下载步骤耗时；后者是整个步骤，不假装是纯网络传输。缺少时间戳为 `unknown`，不是零。
- 原生重跑保留结果必须与前一 attempt 的 API runner/时间/步骤匹配，才计为零**新增**执行成本；新 job ID 或旧时间戳本身不足以证明。
- 运行中的汇总只能输出 partial；最终墙钟要在 workflow 完成后采集。run/jobs API 的 `head_sha` 不证明实际 merge checkout，观测器保留 `tested_checkout_sha=unknown`，checkout 证据另从实际日志核实。

```bash
node agent-harness/ci-run-cost.mjs \
  --repository SummerSec/DeepSonar --run RUN_ID --attempt ATTEMPT \
  --json ci-run-cost.json --summary ci-run-cost.md
```

这些观测不进入 [#961/#970 正式 benchmark 历史](RUNTIME_BUILD_TIMING.md#2-正式历史的信任边界)，不将 PR 自报 provenance 升格可信，也不作为复用通过结论的凭据。

## 4. 三组对照与验收状态

受控对照聚焦 #994 文档误路由：改动形状固定为前述两个文档，baseline 使用 [42379055886](https://github.com/SummerSec/DeepSonar/actions/runs/42379055886) 的原 SHA，修复侧使用基于本补丁的同形验证 PR；分别记录至少三个不同 attempt。除明确的 CI 实验改动外，应用、依赖锁、镜像和测试输入必须核对相同；每组保留事件、base/head、真实 checkout/tree、runner/工具版本、原始时间与缓存观测。不把不同输入、取消、缺数据或重复同一 attempt 充作三个样本。

当前仅已确认 baseline 原始事件为 PR，`CI_PR_MODE=tiered`，原因是精确文档未列白名单；`requiredSuites=[]` / `reverseSuites=[]`，因此这是**核心重活误触发，不是该轮 Reverse 误跑**。对照数字收集完成前不填写提速比例；文档路由实验也不能外推为镜像冷/热/失效的 P95 收益。

## 5. 复用的保留边界

本片不新增 build/setup artifact 复用。[#975 的同 run 原生 base 共享](../agent-harness/reverse-base-identity.mjs)保留原有默认关闭与 SHA/架构/平台/工具集标签核验，未修改仓库变量；没有测量到传输收益前，不因减少构建次数就宣称它更快。

[#992 的独立 PR→main 复用建议](https://github.com/SummerSec/DeepSonar/issues/992#issuecomment-6707927411)尚未实现。本片保持 main 集成 smoke、当前提交汇总和发布门禁完整执行：

- #989 的 preview/main tree 相同，是候选而非授权；#993 的 tree 不同，直接拒绝。
- 当前原生构建还包含可变 Action tag、未全量锁定的 apt/transitive npm 解析；只比较仓库 tree 不能证明有效输入相同。
- #975 base 标签绑定 checkout SHA，不可把 PR artifact 改名或改标签冒充 main 产物。
- 可信成功来源、完整双架构/套件、workflow/script/toolchain/lock/base digest/构建参数/环境权限及内容摘要/有效期任一缺失，仍执行原验收。fork、不可信或失败/取消的来源不进入可信发布缓存。

未交付跨提交复用不写成已优化；也不把两次完整原生运行的总时间直接列为可节省成本。
