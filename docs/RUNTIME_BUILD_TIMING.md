# 运行镜像构建分项量测（#970 / #961 P0）

> 状态：**P0 旁路采集与来源隔离修复已接线，当前修复的最终 SHA Actions 待验**。历史 v1 输出仅作描述性观测，不是可信可比 benchmark；本片不承诺提速。
> 同步日期：2026-11-07

## 1. 范围与接线

复用 [#961](https://github.com/SummerSec/DeepSonar/issues/961) 的量测工具，不修改现有构建 workflow、ARM 路由、发布门禁或 `ci-summary`。

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| 阶段与聚合 | [runtime-build-timing.mjs](../agent-harness/runtime-build-timing.mjs) | v2 记录、来源核验、上下文未知排除、nearest-rank P95 与样本门槛 |
| 离线映射 | [collect-runtime-timing.mjs](../agent-harness/collect-runtime-timing.mjs) | Actions run/jobs payload → 原始观测；不联网、不读 token、不接受 payload 自报可信 |
| API 采集 | [runtime-timing-collect.sh](../.github/ci/runtime-timing-collect.sh) | 只读 Actions API、独立来源清单、受限历史 artifact 下载与导入 |
| 独立工作流 | [runtime-build-timing.yml](../.github/workflows/runtime-build-timing.yml) | PR 仅回归；默认分支 `workflow_run` / `workflow_dispatch` 才采集、聚合、上传 |
| 回归 | [阶段测试](../agent-harness/runtime-build-timing.test.mjs)、[采集器测试](../agent-harness/collect-runtime-timing.test.mjs) | 来源隔离、SHA 语义、未知上下文、阶段缺失与样本不足 |

`ci.yml` 的 ARM 构建与原生冒烟跨 job；API 时间戳适合保留分项观测，不足以凭空补齐 BuildKit 缓存、fingerprint 或历史 checkout 证据。该方案不接触镜像字节，也不改变任何运行时准入。

## 2. 正式历史的信任边界

PR 事件只运行 `regression` job 的两个 Node 测试文件。`collect` job 显式排除 PR，并只允许仓库默认分支；默认分支采集 checkout 固定到 `github.workflow_sha`，`fetch-depth: 0` 用于验证历史 collector revision 的祖先关系，不 checkout 被观测 PR 的代码。

采集脚本从 GitHub API 读取仓库默认分支、collector workflow ID、当前及历史 collector run。导入前逐项核对：

- 运行及 head repository 精确等于当前仓库，branch 等于 API 返回的默认分支；
- event 只能是 `workflow_run` 或 `workflow_dispatch`，workflow 路径与 ID 必须对应本 collector；
- 历史 run 必须成功，collector `head_sha` 是固定 checkout 的祖先；当前 run 的 SHA、attempt 与 GitHub 宿主环境一致；
- artifact 中样本必须是当前 v2 schema，`collector_revision` 精确匹配本版，且 run ID/attempt、仓库、event、branch、workflow 与 collector SHA 全部匹配独立 API 记录。

下载容器的 producer run 本身也要先通过核验；PR artifact 即使伪造成功 smoke、schema 或另一可信 run 的 provenance，也不能进入正式历史。artifact 内的代码从不执行。聚合器收到的是采集脚本写在 artifact 目录之外的 trust 清单；JSON 自报 provenance 不是信任根。没有独立 trust 清单，正式聚合不接纳任何记录。

旧 v1 或缺少 provenance 的样本直接排除，不兼容、不迁移，也不由当前 collector 补签。历史 artifact 中保留的原 collector 身份不改写；无法再核验其生产 run 时同样排除。当前采集记录与历史记录按原 run/attempt 去重，重复不增加样本数。

## 3. observed head 与 tested checkout 严格分开

`provenance.collector_sha` 表示运行采集器代码的 revision；`source.source_sha` / `meta.head_sha` 表示被观测 Actions run 的 `head_sha`，两者不能混用。

实际测试版本单列为 `source.tested_checkout_sha` / `meta.tested_checkout_sha`，还须有对应不可变 checkout 证据。当前 run/jobs API 不提供这项证据，因此旁路采集一律记 `unknown`，并标记 `checkout_evidence=unavailable-in-run-jobs-api`。PR 默认 checkout 经常是 merge commit，不是其分支 head；即便输入 payload 自带 `test_sha`、`tested_checkout_sha` 或 provenance 字段，采集器也不采用。不会读取当前 `refs/pull/<n>/merge` 来替历史 run 补猜测试版本。

本片不新增日志解析或历史 checkout 证据采集。未来若接入不可变证据，head 与 tested SHA 可以不同；仅已知 head 不足以证明 tested SHA。原始时间戳、run URL、event、branch、source SHA、attempt 仍保留，排除统计不等于删除观测。

## 4. 阶段、场景与可比筛选

阶段为 `queue`、`handoff`、`download`、`compile`、`export_push`、`build`、`pull`、`smoke`、`native_smoke`。

- queue 与跨 job handoff 单列，不计入 build+smoke 合计。
- 未拆分 BuildKit 时只记录 `build` 整段，不冒充 download/compile/export 分项。
- 同一步中的 pull+native smoke 只记录 `native_smoke`，与拆分 pull/smoke 不叠加；混用排除。
- 明确 src 复用而 skipped 是带 reason 的观测零耗时；缺失阶段不是零。
- `warm` 仅由明确 build skip 推断；重建默认 `unknown`，不能由时间戳猜 cold / invalidated。手动 scenario 只是受控标注，不补齐缺失证据。

正式可比样本须来源通过上述核验、阶段齐全无冲突、ARM build/smoke 成功且 failure_class=none，另外 tested checkout SHA、fingerprint、base digest、matched inputs 和 scenario 均已知。任一重要上下文未知，只保留描述性观测，不计入 benchmark。source 与 meta 的 tested SHA/证据冲突也排除。

**当前纯 API 旁路无法满足全部上下文条件，故成功 smoke 或可信 collector 并不意味着有可比样本；可能持续为零，不能为了达到门槛把 unknown 改成已知。** 排除原因分别报告来源未核验、旧 schema、上下文未知、失败、取消、失败未分类、阶段不完整和重复观测。

每个场景不足三个已核验可比样本时 P95 为 null，摘要显示“样本不足”；有足够受控样本才使用 nearest-rank。单纯冷热量级差异、跨 PR 的不同输入或缓存状态不构成提速结论。本片没有交付受控冷/热/失效各三次对照。

## 5. 执行链与验证边界

默认分支的 collector：回归 → 固定自身 revision → 读取 API 元数据与 run/jobs → 核验历史 producer → 下载/筛选 v2 样本 → 映射当前观测 → 带独立 trust 清单聚合 → summary 与 90 天 artifact。

`workflow_dispatch` 的 `run_ids` 可定向回填，留空则读取最近 `recent` 个已完成 CI run。历史检索只限默认分支成功 collector，再逐一验证 event/repo/workflow/revision；检索不到或旧 provenance 缺失只会减少可采历史，不会借 PR artifact 补足。release 未具名 build step 仍不猜测；Chrome 专项的 amd64 观测也不能冒充 ARM 样本。

回归在上述独立 workflow 的 `regression` job，以及现有 `pnpm ci:unit:runtime-timing` 入口接线；测试含伪造可信 provenance 的成功 PR artifact、有效可信历史、旧 schema 排除、缺 checkout 证据及 head/tested SHA 不同等场景。本轮仅静态审查与 `git diff --check`，**未运行本地测试、构建、typecheck、bash/YAML 检查、collector 或任何实测**；新信任链的 Actions 执行证据待最终 SHA 验收，不沿用原 PR 的 27/27 结果。

## 6. 旧版首次回填观测（保留历史，不进入 v2 正式统计）

原 v1 在 2026-11-07 从 30 个历史 CI run 写出 21 条观测，旧筛选器称其中 8 条“可比”：unknown 4 条的中位数为 8,544,000 ms、P95 8,584,000 ms；warm 4 条的中位数为 48,000 ms、P95 56,000 ms。原采集者还记录了 PR workflow 上传同名 artifact 的现象。

这些是旧实现输出的历史描述，不是本轮重新运行或核验结果。#970 评审已确认其 collector 来源隔离和 PR tested SHA 口径不足；缺少 v2 provenance 与不可变 checkout/上下文证据，不纳入新的正式历史，不重复发布为可比 P95，也不能推导任何速度收益。原 run 观测不被补签或改写。

## 7. #992 的工作流成本观测不是本页的正式 benchmark

[#992 验收记录](CI_COST_ACCEPTANCE_992.md)增加核心/Reverse 汇总中的[只读观测器](../agent-harness/ci-run-cost.mjs)，直接列出当前 attempt 的 job queue、执行、setup/typecheck/build 和 artifact 步骤时间，并用前一 attempt 的 API 证据排除原生失败重跑中保留的旧执行成本。这是独立的工作流路由/重试观察，不修改本页 collector、历史 trust 清单或 v2 筛选器。未知 tested checkout、环境或缓存状态仍保持 unknown；#994 同形文档路由对照不能冒充冷/热/失效的可信镜像 benchmark。
