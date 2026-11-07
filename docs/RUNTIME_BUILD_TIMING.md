# 运行镜像构建分项量测（#961 P0）

> 状态：**P0 工具与采集链路已交付，并完成 30 个历史 CI run 的只读回填实测；受控 cold / invalidated 标注与「三类各三次」可比样本仍未累积**。本文只描述已落地的工程口径与描述性观测，不描述任何提速结论。
> 同步日期：2026-11-07

## 1. 交付范围

[#961](https://github.com/SummerSec/DeepSonar/issues/961) 的 P0 是**可观测性基础设施**：先把运行镜像构建的分项耗时、缓存复用情况和可比样本判定做成可复核的证据，P2 的稳定 V8 builder / toolchain 缓存拆分与「冷 / 热 / 失效各三次 + P95」真实对照必须靠它先攒数据。一次 CI 运行只能产生一个样本，因此本片不承诺任何 benchmark 数字。

本片交付：

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| 数据模型 / 聚合器 | [`agent-harness/runtime-build-timing.mjs`](../agent-harness/runtime-build-timing.mjs) | 分阶段计时、结构化证据、Markdown 摘要、`GITHUB_OUTPUT`、中位数 / nearest-rank P95、样本门槛 |
| 离线采集器 | [`agent-harness/collect-runtime-timing.mjs`](../agent-harness/collect-runtime-timing.mjs) | 把 GitHub Actions job/step 时间戳映射成标准 run 记录 |
| 采集脚本 | [`.github/ci/runtime-timing-collect.sh`](../.github/ci/runtime-timing-collect.sh) | 组装 API payload、回填历史证据 artifact |
| 独立 workflow | [`.github/workflows/runtime-build-timing.yml`](../.github/workflows/runtime-build-timing.yml) | `workflow_run` / `pull_request` / `workflow_dispatch` 触发，跑回归、采集、聚合、上传 artifact |
| 单测 | `runtime-build-timing.test.mjs`、`collect-runtime-timing.test.mjs` | 27 个用例，覆盖口径与 fail-closed 边界 |

## 2. 为什么不在构建 workflow 里埋点

`ci.yml` 在 `chrome-fuzz-arm64-build` 构建镜像，在另一个 `chrome-fuzz-arm64` job 里做原生 ARM 冒烟；`release.yml` 的 `chrome-image-builds` / `chrome-fuzz-arm64-smoke` 同样是跨 job。计时状态文件放在 `$RUNNER_TEMP` 只能在同一 job 内共享，跨 job 必须加 artifact 搬运。同时 #964 与 #965 都还在修改 `ci.yml`，三方同时改同一段会制造不必要的合并冲突。

GitHub Actions API 已经给出每个 step 的 `started_at` / `completed_at`。因此 P0 采用**完全无侵入**的旁路采集：

- 不修改 `ci.yml`、`chrome-runtime.yml`、`release.yml`；
- 不修改任何门禁条件、运行计划或 `ci-summary` 判定；
- 采集器只读 Actions API，不需要写权限、不接触构建产物、不缓存凭据；
- 可以对历史 run 回填，这是攒够每类三次样本的现实途径。

## 3. 数据口径

### 阶段

`queue`（run 开始 → build job 开始）、`handoff`（build job 结束 → 原生 smoke job 开始）——两者都单列、不计入合计；`download` / `compile` / `export_push`（P2 拆分后才会有）、`build`（BuildKit 整段回退）、`pull`、`smoke`、`native_smoke`。`handoff` 是实测中发现的真实跨 job 间隙（一次 main 运行里约 159 秒），显式记录而不是让它悄悄消失。

- 当前 Dockerfile 把源码拉取、GN 处理和编译放在一个大 `RUN`，所以只有 `build` 整段计时，**不能用于阶段归因**。
- 原生冒烟 job 把 `docker pull` 和 `test-chrome-runtime.mjs` 写在同一 step，step 级时间戳拆不开，因此诚实记为合并观测 `native_smoke`。它与拆分的 `pull` + `smoke` 覆盖同一时间窗，端到端合计可比，但两者**绝不叠加**；同时出现时判为口径冲突并排除该样本。
- src 缓存复用时构建**确实没有发生**。`skipped (observed)` 是明确观测到的 0 ms，带 reason，与「证据缺失」严格区分；缺失阶段仍然不按 0 计。

### 场景与失败分类

`cold` / `warm` / `invalidated` / `unknown`；失败分类 `none` / `apt_external` / `compile` / `cache_invalidation` / `unknown`。

只有 `build` step 被跳过可以可靠推断为 `warm`。**冷与失效无法从时间戳区分**：需要 BuildKit 的缓存命中事件（P2）。因此采集器默认把重建标为 `unknown`，受控 benchmark 必须通过 `workflow_dispatch` 的 `scenario` 输入显式标注，不允许自动猜测。

### 可比样本判定

一条记录只有全部满足才算可比并进入中位数 / P95：

1. 所需阶段齐全（未拆分时为 `build` + 原生冒烟；拆分后为三项细粒度阶段 + 原生冒烟）；
2. 没有 `mixedSmoke` 口径冲突；
3. `outcome == success`，且 `failure_class == none`；
4. 原生 ARM smoke job 真实成功——**缓存命中不能替代原生冒烟通过**。

`outcome` 按**被测 ARM 链路**（build job + native smoke job）的结论判定，不按整个 CI run 的结论判定：同一 run 里无关的 Windows / 数据库 job 失败，不该让一条完整且原生冒烟已通过的计时证据作废。run 级结论仍写入 `source.run_conclusion` 供追溯；run 或链路被取消时整条排除。

失败、取消、排队、未分类失败、证据不完整各自单列统计。每个场景的可比样本数 < `minSamples`（默认 3）时**不报告 P95**，只报中位数和「样本不足」。P95 用 nearest-rank，不做插值。

### 证据字段

`base_sha` / `head_sha` / `test_sha` / `fingerprint` / `base_digest` / `src_reuse` / `buildkit_cache` / `matched_inputs` / `failure_class`。Actions job payload 只暴露 step 时间，**不暴露 step outputs**，所以 `fingerprint`、`base_digest`、`buildkit_cache`、`matched_inputs` 在旁路采集下如实写 `unknown`，不伪造。这些字段留给 P2 在 job 内埋点时补齐。

## 4. 采集链路

```
ci / chrome-runtime / release 完成
        │ workflow_run
        ▼
runtime-build-timing.yml
        │ gh api: actions/runs/{id} + jobs（分页）
        ▼
.github/ci/runtime-timing-collect.sh
        │ 组装 { run, jobs }[]，并 gh run download 回填历史 artifact
        ▼
collect-runtime-timing.mjs（纯离线）
        │ <gha-{runId}>.json（状态） + .report.json（含来源追溯）
        ▼
runtime-build-timing.mjs aggregate
        │ GITHUB_STEP_SUMMARY + aggregate.json
        ▼
artifact: runtime-timing-evidence（保留 90 天）
```

`workflow_dispatch` 可指定逗号分隔的 `run_ids` 做定向回填；留空则取最近 `recent` 次已完成的 `ci` run。每次运行把过去 30 次本 workflow 的成功 artifact 拉回证据目录，同名 run id 以最新采集覆盖，因此聚合是幂等的。`workflow_run` 只携带单个 run id，所以合并后应手动跑一次 **`workflow_dispatch`（`run_ids` 留空）** 初始化历史证据 artifact；否则首次自动运行只有一条样本，摘要会如实显示「样本不足」。

## 5. 验收与命令

```bash
pnpm ci:unit:runtime-timing        # 27 个用例，纯 node --test，无需数据库或 pnpm install
node --test agent-harness/runtime-build-timing.test.mjs agent-harness/collect-runtime-timing.test.mjs
```

`runtime-build-timing.yml` 的 `量测工具与采集器回归` 步骤直接执行同一组用例，不需要完整 workspace 安装。采集器不联网，job/step 映射全部由 fixture 覆盖。

2026-11-07 另用只读 GitHub Actions API 取回 30 个已完成 `ci` run 的 job payload，在本地跑完整 `collect → aggregate` 链路，核对了真实 step 名（`Build Chrome Fuzz arm64 by digest`、`原生执行 Chrome Fuzz 不可变 digest 冒烟`）、`skipped` 的 src 复用 step、以及跨 job 时间戳。结果见 §7；合并后的首个 `workflow_run` 仍需再核对一次线上 artifact。

## 6. 已知限制与后续

- `release.yml` 的 `docker/build-push-action@v6` step 没有显式 `name`，Actions payload 无法可靠选中它。当前只有 `ci.yml` 的 `Build Chrome Fuzz arm64 by digest` 能产出完整可比样本；其余工作流的 run 会因阶段缺失被正确排除，而不是补一个猜测值。要纳入 release，需要给该 step 具名或提供显式选择器。
- `chrome-runtime.yml` 是 amd64 专项，不是 #961 的 V8 ARM 目标；不可把它已有的路径 / 缓存策略推广到整个 CI。
- #965 计划跳过的 ARM run、docs-only 和 Draft 运行不会产生样本，这是预期行为，不是采集失败。
- P2 仍需：把 Dockerfile 的稳定 builder / toolchain 拆层，输出 `download` / `compile` / `export_push` 真实分项，并暴露缓存命中事件以区分 cold 与 invalidated、补齐 fingerprint 等元数据。
- P3 仍需：CI / release 兼容缓存复用。
- **本片不提供受控的三类各三次样本，也不提供任何提速百分比。** 在每类可比样本数达到 3 之前，摘要只会显示「样本不足」。

## 7. 首次历史回填观测（2026-11-07，非受控）

只读拉取 30 个已完成的 `ci` run（2026-11-06 区间），本地跑完整采集与聚合：

| 项 | 结果 |
| --- | --- |
| 写入证据 | 21 条（另 9 条为计划跳过 / 无 ARM job，不产样本） |
| 可比样本 | 8 条 |
| 排除 | 失败 4、取消 9、未分类失败 0、证据不完整 0 |
| `unknown`（发生真实 V8 交叉编译） | 4 条，中位数 **8,544,000 ms**（约 142 分钟），P95 8,584,000 ms |
| `warm`（src 缓存复用，build step skipped） | 4 条，中位数 **48,000 ms**（48 秒），P95 56,000 ms |

逐条核验过 4 条长样本：`chrome-fuzz-arm64-build` 与 `chrome-fuzz-arm64` 两个 job 均 `success`，build step 起止时间约跨 2 小时 22 分；其中两条 run 级 `conclusion=failure` 来自同 run 的其它 job，按 §3 的链路级判定不影响计时证据。原生冒烟与跨 job 交接（`handoff` 约 5 秒；main 一次为 157 秒的 ARM runner 等待）都有独立时间戳。

**这些数字不是 benchmark 结论**：样本来自不同 PR 分支、不同输入与缓存状态，`cold` / `invalidated` 未被显式标注（全部落在 `unknown`），也不是同一改动的前后对照。它们只能说明 P0 已经能把「真实编译」和「src 复用」在量级上分开记录；受控三类对照与任何提速判断仍待 P2 的缓存事件输出和显式 scenario 标注。
