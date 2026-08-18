# Changelog

发布条目依据已验证的 Git tag 与仓库变更维护，后续新增发布条目统一使用中文。不可变的 `vX.Y.Z` Git tag 是产品发布版本；根目录与 workspace package 的版本仅为私有内部元数据（`0.1.11`），不是发布标识。

## [Unreleased]

## [0.1.39] - 2026-08-18

### 新增

- 每个任务提供数据库权威的 drain pause/start：暂停只阻止新 Job 领取，已运行 Job 安全收尾；列表与画布统一显示暂停中/已暂停状态。
- 项目可通过 `maxConcurrentJobs` 独立收紧 claim 配额，支持 `0` 暂停项目调度且不放宽全局硬上限。
- 模块源同步结果区分“已更新”与“已是最新”。
- 新增 Job 级“按当前配置重新执行”：保留同一 Job、画布与历史 Attempt/effect，按当前 RoleConfig、Credential、项目策略和 runtime image 完整重冻快照。

### 修复

- 启动对账批量 orphan 的 sibling Worker 不再被新 Hub 抢占恢复入口；一次任务恢复按原 Job ID 批量重新入队并建立新 Attempt，旧 unknown effect 不自动重放。未 finalize 的 normalized stream 以有界 synthetic manifest 保持可见。
- 官方镜像清单不可达时 bundled fallback 只补缺失版本，不覆盖现有引用或信任；普通网络/拉取扫描失败不再撤销官方可信版本。
- Pi Gateway 运行时补齐 `auth.json`、`provider/model` 选择与空响应失败收口，并增加无语义产出的停滞 Reaper。
- DSH 完整 package closure 统一升级并固定到 `0.1.0-rc.7`，Cordis 使用合法的 agent-spine bash 配置、唯一工具注册和显式固定 integrity 的 subprocess implementation；Base 镜像新建或复用时均执行断网 JSON-RPC 启动冒烟。
- Agent stderr 以精确脱敏、总量有界的 normalized evidence 保存，Job 错误仍保持短摘要。
- 本地 Docker/vfs 宿主增加受管容器/卷周期 desired-state 清理、非强制 runtime image GC 和磁盘水位 claim 门禁；禁止 broad prune 和删除非 DeepSonar 资源。
- Job `resume` 现明确定义为使用旧冻结快照创建新 Attempt；当前 CLI/模型/凭据/runtime identity 漂移或无法解析时稳定返回 `409 SNAPSHOT_STALE`。任务级启动中断批次也会原子拒绝 stale 快照并返回 Job IDs，不再静默使用旧模型。

### 部署 / 升级说明

- 本版本不修改数据库 Schema。
- DSH runtime 依赖闭包变化会重建 Base/Audit/Kali 镜像；发布后应等待新 runtime catalog 回写再升级生产栈。
- rootless/vfs 部署须把 `DEEPSONAR_HOST_DISK_SOURCE` 指向 Docker data-root；达到 error 水位后暂停新 claim，清理和已运行 Job继续工作。

## [0.1.38] - 2026-08-17

### 修复

- Model Gateway 对 Anthropic 同时注入 `Authorization: Bearer` 与 `x-api-key`，并在凭据 `base_url` 已含 `/v1` 时避免拼成 `/v1/v1/messages`。
- Job token 模型白名单同时覆盖 Claude CLI 别名（如 `fable`）与 settings 解析出的上游模型 ID，避免网关 403。
- Windows 主机解析 Docker Engine 默认走 named pipe，不再误用 unix socket。

### 变更

- 保留 `pnpm db:up` 独立开发库；新增 `pnpm db:up:deploy` 可将开发态改连 deploy 栈 Postgres（`POSTGRES_BIND`，与独立库互斥占用 5432）。

## [0.1.37] - 2026-08-17

### 修复

- `image-admission` 的扫描器环境变量未设置或留空时默认使用官方不可变 `@sha256` digest；显式覆盖仍必须是完整 digest，非法值继续 fail closed。
- 修复 S33 启动门禁：`project_opt_in` 专项镜像不再阻塞 Dispatcher，官方 Base/Audit/Kali 仍需就绪；`/health` 的 readiness 同时反映 Dispatcher 是否启用，启动预热失败持续输出可诊断日志并按有界退避重试。
- Attempt outcome 不再持久化完整 summary，仅保留 `summary_sha256` 与 UTF-8 `summary_bytes`；超限输入改为稳定、可重试的控制错误。
- managed gateway 增加启动预热、`Created` 残留处理和独立的 `docker run` 超时；创建或健康检查失败时按受管标签、owner 与 inspect 得到的容器 ID 限定清理，避免误删其他容器。
- skill source 启动同步支持可取消超时，等待底层 clone/rev-parse 真正收口后再重试；单个来源失败会汇总但不阻塞同轮后续来源，Scheduler 停止时主动取消同步。

### 发布说明

- 不可变 `v0.1.36` 因缺少 CHANGELOG 章节在发布元数据门禁失败，未发布任何制品；`v0.1.37` 是首个包含以上变化的正式发布。

## [0.1.35] - 2026-08-16

### 变更

- 人类用户名/密码登录增加持久化暴力破解防护：任意校验（含成功）都占额；紧桶为用户名+IP 的 5 次/5 分钟，粗桶为 IP 的 20 次/5 分钟。Web 代理写入入站 TCP peer 的 `X-Forwarded-For`，Scheduler 只信任 1 跳。IP 超限不再插入 identity 行，过期窗口在占额事务内回收。超限返回 `429 LOGIN_RATE_LIMITED`。Schema 升至 v35（`login_rate_limits`）。
- 官方运行时镜像的默认同步只拉取每个产品在所选 registry 通道上的最新版本；历史可信 digest 继续服务显式 pin 与已冻结 Job 快照。
- Provider 角色绑定行采用固定 CLI/镜像列宽，并在右侧集中显示绑定状态与模型信息，长镜像标签不再挤压控件。

### 修复

- Scheduler 启动时先监听健康端口并暴露 readiness 详情，在有效 Base/Audit/Kali 镜像全部本地可用前不启用 Dispatcher；准备失败按有界退避持续重试，避免把镜像拉取故障推迟到任务运行期。
- 项目镜像策略、角色绑定与 registry 通道变更改为异步准备：新引用验证并拉取成功后才原子保存；准备期间返回 `202 saved:false`，旧配置继续生效。Job 遇到缺失镜像时以 `runtime_image_not_ready` 失败并记录可诊断原因。
- 修复 DSH Provider 设置在 Job 快照中按 TOML 错误解析的问题，现按 DSH 原生 YAML 冻结，同时保留凭据清理边界。

### 部署 / 升级说明

- 本版本包含 Schema v35；已有数据库须先运行 `pnpm db:rebuild -- --plan` 检查，再以 `pnpm db:rebuild -- --apply` 重建回填。

## [0.1.34] - 2026-08-16

### 变更

- 更新 `deepsonar-management` 项目 Skill：补齐 standard/compose/定时任务、provision 并发、画布 Fact、广播账本与人工消息命令，并移除失效的旧 Fact 验证路径。

### 修复

- 修复 Agent 可纠正的控制输入、schema、payload 与 summary 错误会终止 Agent/Job 的问题，改为返回稳定、可重试的控制错误；`mark_job_done` summary 按 8192 UTF-8 字节限制，Attempt outcome 仅保存摘要哈希与字节数；延迟执行的 Hub/Human 决策在接受前预检，并在最终事务中重新校验。修复 #166。

## [0.1.33] - 2026-08-15

### Added

- Added full-topology PNG export to Task Canvas.

### Changed

- Task Canvas node filters and the broadcast ledger now default to compact collapsed docks and expand independently without covering the graph.
- Production provisioning now defaults to a 900-second budget; rootless Docker `vfs` deployments are documented to serialize provisioning through the database setting.

### Fixed

- Managed Gateway sidecars now carry a proxy-script revision and are rebuilt when the route contract changes, preventing stale pre-`/control/v1` proxies from surviving upgrades.
- Provision timeouts now wait for external creation and cleanup to settle, with a final Job/Attempt-label sweep for containers created after cancellation.
- Image admission validates every scanner digest at startup instead of claiming scans before discovering an empty or mutable scanner configuration. Addresses #165.

### Deployment / Upgrade Notes

- The immutable `v0.1.32` tag failed the release metadata gate before any artifact was published. `v0.1.33` is the first published release containing these changes.

## [0.1.31] - 2026-08-15

### Added

- Added `pnpm db:rebuild` to back up an existing database, apply the current `database/schema.sql` baseline, and copy overlapping columns. Scheduler boot still fail-closes on version mismatch and does not run incremental ALTER statements.

### Fixed

- Fixed Task Canvas Fact polling so the one-second lifecycle clock no longer rebuilds the five-second polling interval and floods `/canvases/:id/facts`. Closes #163.
- Fixed Job-scoped Platform Control API provisioning so `DEEPSONAR_API_BASE_URL`, `DEEPSONAR_API_TOKEN`, and `DEEPSONAR_JOB_ID` are present in Worker `Config.Env`; authentication remains disabled until the Job reaches `running`, and terminal cleanup revokes the grant. Closes #164.

## [0.1.30] - 2026-08-15

### Added

- Added `standard | compose` task kinds with explicit confirmed-Finding seed selection, immutable seed snapshots, read-only Canvas projection, governed retry validation, and matching Tasks/Findings Web entry points. Closes #161.
- Added DeepSeek Harness Provider YAML for arbitrary Pi-AI routes, task/default execution modes, model-owned third-party reasoning mappings, and governed subagent routing through `dsh-reasoning-settings`.
- Added searchable multi-select filters and redesigned Canvas broadcast and Agent Session inspection surfaces.

### Changed

- Provider-owned reasoning now uses each CLI's native contract: Claude Code `effortLevel`, Codex `model_reasoning_effort`, OpenCode `--variant`, Pi `--thinking`, and canonical DSH effort IDs mapped by model YAML.
- Runtime and Scheduler session handling now preserve exact CLI session identity, bounded diagnostics, cancellation, provisioning reconciliation, and API-only control semantics across all governed Agent CLIs.

### Fixed

- Fixed Finding verification, human evidence priority, convergence, shared-asset cleanup, and project runtime-image policy boundaries.
- Fixed the runtime-image marketplace CI smoke after RoleConfig reasoning removal and made its Job cleanup retry PostgreSQL deadlocks without leaking active real-mode sandboxes.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.30` tag; runtime image tags use `0.1.30` without the `v` prefix.
- Database schema is now v34. Existing databases must be rebuilt from `database/schema.sql`; the project intentionally provides no in-place migration path.

### Runtime Images

- Base, audit, and Kali images install the checksum-pinned `dsh-reasoning-settings@0.3.0` host plugin alongside the official DSH 0.1.0-rc.6 runtime; generated headless Cordis compositions mount its inheritance and subagent-routing controls.

## [0.1.29] - 2026-08-14

### Fixed

- Fixed Chrome runtime promotion to strip BuildKit provenance attestations before assembling the clean multi-architecture index copied to ACR and Docker Hub. The failed immutable `v0.1.28` tag is not reused.

## [0.1.28] - 2026-08-13

### Added

- 增加通用 CLI 客户端上下文预算：Credential 基准、RoleConfig 覆盖、Job 冻结展示、Agent 配置包和平台导入导出均使用 1024–10000000 的统一范围；Codex/OpenCode/Pi 物化到各自受支持落点，Claude Code 只冻结展示且不伪造绝对窗口设置。该预算不会提升 Provider、模型或账号的上游能力。Refs #144
- Added DeepSeek Harness as a governed fifth Agent CLI using the official unattended JSON-RPC server, deterministic multi-turn sessions, exact-session recovery, structured event streaming, completion gating, standard Skill registry/filesystem/tool support, and Job Session archival/viewing.

### Changed

- Pinned Claude Code 2.1.231, OpenCode 1.18.18, and the official DSH 0.1.0-rc.6 JSON-RPC package closure in governed runtime images.
- Database schema is now v30. Existing databases must be rebuilt from `database/schema.sql`; the project intentionally provides no in-place migration path.

### Fixed

- 修复 Job 控制能力元数据：Claude Code、Codex、OpenCode、Pi 与 DSH 现在均如实声明已注入的 HTTP Platform Control API；支持 MCP 的运行时仍保留过渡通道，由 Agent 对每次逻辑操作自行二选一。
- 修复 Anthropic 兼容子路径网关的模型发现与凭据健康检查：按有界有序候选探测模型端点，且仅在 HTTP 404/405 时回退。
- 修复项目镜像策略投影不一致：`inherit_global` 继续继承全局镜像，`project_managed` 只使用项目角色映射；项目 RoleConfig 的遗留 `runtime_image_key` 不再通过写入、导入导出、展示或 readiness 生效。

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.28` tag. Rebuild existing databases for schema v30 before starting the Scheduler.

### Runtime Images

- Base, audit, and Kali images include only the pinned DSH machine runtime and official JSON-RPC components; DSH TUI, Web UI, skins, and `dsh-cc-tui` are explicitly excluded.

## [0.1.27] - 2026-08-13

### Fixed

- Fixed registry release evidence by using the clean runnable GHCR version index as the canonical digest shared with ACR and Docker Hub, while retaining full provenance on immutable `src-*` tags.

## [0.1.26] - 2026-08-13

### Fixed

- Fixed ACR and Docker Hub promotion for attested BuildKit indexes by selecting exact runnable platform manifest digests before cross-registry assembly.

## [0.1.25] - 2026-08-13

### Fixed

- Fixed Chrome Fuzz arm64 builds by using static ELF and runtime-contract checks under QEMU while retaining executable smoke tests on native arm64 runners.
- Fixed ACR and Docker Hub image promotion by filtering to supported platforms so unsupported provenance-attestation descriptors are not copied, while GHCR promotion retains provenance.
- Added a hard gate to public `POST /jobs` that requires the requested project role to be enabled.

## [0.1.24] - 2026-08-12

### Added

- Added Scheduler-owned Job Attempt/effect persistence, cancellable and reconcilable provisioning, Canvas delivery and model-usage ledgers, and bounded runtime context identity/compaction diagnostics.
- Added Pi as a governed API-only RPC runtime with a fixed static control Skill, exact session-file recovery, approved Extension loading, immutable runtime-image packaging, and real Docker RPC smoke coverage.
- Added Job-scoped Platform Control API capabilities with inline operation schemas, short-lived allowlisted tokens, idempotent invocation, terminal revocation, and PostgreSQL integration coverage for Fact, Finding, Hub decision, and Job completion.
- Added project-managed runtime-image policy and governed provider/account configuration flows across Scheduler and Web surfaces.

### Changed

- Finding verification convergence now honors `minVerifySeverity`; task reports are versioned from their convergence input and can include lower-severity pending Findings as explicitly uncovered items.
- Gateway retries transient upstream failures only before response delivery, while supported Agent CLIs resume the exact captured session with bounded retries and fail closed on identity mismatch.
- Official runtime-image admission now selects an immutable reference from the configured deployment registry and re-scans a previously revoked official digest only when the trusted catalog moves it to a different proven registry reference.
- Database schema is now v27. Existing databases must be rebuilt from `database/schema.sql`; the project intentionally provides no in-place migration path.

### Fixed

- Fixed provisioning cancellation races, late sandbox creation cleanup, Attempt undefined-resource persistence, shared-asset helper residue, and ambiguous Canvas delivery settlement after process failures.
- Fixed missing task-level reports caused by all-severity convergence, stale report inputs, and report version reuse when the convergence snapshot changes.
- Fixed ACR-only deployments revoking official images after admission attempted unreachable GHCR references, including recovery for rows already revoked by the old reference.
- Fixed Pi RPC CI startup, writable bind mounts, hard-kill recovery, exact session reuse, and bounded diagnostics when the RPC process exits early.
- Fixed oversized Gateway request error handling and shared-asset conflict paths so transient failures remain recoverable without duplicating semantic side effects.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.24` tag. Runtime image tags use `0.1.24` without the `v` prefix.
- Rebuild existing databases for schema v27 before starting the Scheduler. Configure `DEEPSONAR_IMAGE_REGISTRY` to the deployment registry/namespace so official admission and runtime pulls use the same published channel.

### Runtime Images

- Base and audit images now contain the pinned Pi RPC runtime alongside the existing governed CLIs. The release reuses unchanged fingerprinted images and rebuilds only presets whose Dockerfile, manifests, build arguments, platform set, or dependencies changed.

## [0.1.23] - 2026-08-10

### Fixed

- Fixed Chrome Fuzz arm64 V8 builds by using the pinned target LLVM/compiler-runtime toolchain and arm64 sysroot paths.
- Recovered Chrome Fuzz smoke validation on x64 runners by pulling and running the immutable image with an explicit `linux/arm64` platform.

### Deployment / Upgrade Notes

- This recovery release is identified by the immutable `v0.1.23` tag. Runtime image tags use `0.1.23` without the `v` prefix.

## [0.1.21] - 2026-08-08

### Added

- Added visible live-stream thinking/reasoning output, project-level sandbox resource overrides, and three project-opt-in Chrome specialist runtimes for audit, headless/CDP testing, and real V8 fuzzing.
- Added governed terminal copy and keyboard behavior, including selection-aware Ctrl/Cmd+C and Tab/Shift+Tab passthrough.

### Changed

- Job detail terminals now open on demand, live results keep a single vertical scroller, and runtime/report convergence paths retain their durable payload and completion state.
- Runtime image catalogs expanded from six to nine official multi-architecture images, with native Chrome child builds, immutable digest assembly, and smoke-gated release publication.
- Database schema is now v24. Existing databases must be rebuilt from `database/schema.sql`; there is no incremental migration path.

### Fixed

- Fixed Job-detail Escape handling and terminal lifecycle leakage when switching Jobs.
- Fixed missing Finding report payloads that left root-active work pending, and fixed successful completion-gate continuation after a 429 being recorded as failure.
- Fixed terminal copy feedback, prompt double-scrollbars, and real-time reasoning visibility in the Job detail UI.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.21` tag. Runtime image tags use `0.1.21` without the `v` prefix and must not use `latest`.
- Rebuild existing databases for schema v24 before starting the Scheduler; the repository intentionally has no in-place migration path.

### Runtime Images

- The release publishes nine official multi-architecture runtime image catalogs: the existing six plus Chrome Audit, Chrome Test, and Chrome Fuzz. Chrome images remain project-opt-in and are recorded only after immutable digest and native-architecture smoke validation.

## [0.1.20] - 2026-08-08

### Added

- Governed runtime adapters now execute Claude Code, Codex, and OpenCode through a shared capability contract with frozen Job snapshots, normalized structured events, control MCP enforcement, and fail-closed readiness checks.
- Running local-docker Jobs now expose an authenticated, permission-gated PTY terminal beside the live event stream, with bounded traffic, resize support, audit metadata, and automatic sandbox cleanup.

### Changed

- Official runtime image selection now defaults to the Aliyun ACR channel, while jobs continue to freeze governed immutable image digests.
- Production deployment guidance and runtime configuration now reflect the current provider, gateway, object-storage, and image-channel behavior.
- GitHub Releases now publish the exact validated version section from this changelog and fail before image builds when tag or compare-link metadata is inconsistent.
- Runtime image size budgets now account for the governed Codex and OpenCode native payloads while retaining explicit CI-enforced limits for base, audit, and Kali images.

### Fixed

- Hardened runtime control, task observability, semantic event fixtures, fake-mode semantic output, agent completion idempotence, and isolated Agent CLI home directories.
- Canvas viewports now re-fit after durable graph additions or removals without timer races, while preserving trace and focused-node behavior.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.20` tag. Runtime image tags omit the `v` prefix; deployment can instead consume the published digest registry.
- The release workflow updates the bundled runtime registry and `deploy/.env.example` after the image catalog passes validation.

### Runtime Images

- The release workflow publishes and records the six official multi-architecture runtime image catalogs with inspected immutable digests and channel evidence.

## [0.1.19] - 2026-08-07

### Added

- Provider account settings and production deployment alignment were added.

### Changed

- Runtime image metadata and deployment image tags were synchronized for the release.

### Deployment / Upgrade Notes

- Product version is the immutable `v0.1.19` tag; image tags use `0.1.19` without the `v` prefix.

### Runtime Images

- The six-image runtime registry was published with multi-architecture digest metadata and release assets.

### Fixed

- CI skipped duplicate runtime-image smoke tests where the release pipeline already covered the same checks.

## [0.1.18] - 2026-08-07

### Fixed

- Restored the OpenHarmony vendored repository launcher checksum required by the runtime image build.

### Runtime Images

- The bundled runtime registry was synchronized for the `v0.1.18` release.

[0.1.39]: https://github.com/SummerSec/DeepSonar/compare/v0.1.38...v0.1.39
[0.1.38]: https://github.com/SummerSec/DeepSonar/compare/v0.1.37...v0.1.38
[0.1.37]: https://github.com/SummerSec/DeepSonar/compare/v0.1.36...v0.1.37
[0.1.35]: https://github.com/SummerSec/DeepSonar/compare/v0.1.34...v0.1.35
[0.1.34]: https://github.com/SummerSec/DeepSonar/compare/v0.1.33...v0.1.34
[0.1.24]: https://github.com/SummerSec/DeepSonar/compare/v0.1.23...v0.1.24
[0.1.33]: https://github.com/SummerSec/DeepSonar/compare/v0.1.32...v0.1.33
[0.1.31]: https://github.com/SummerSec/DeepSonar/compare/v0.1.30...v0.1.31
[0.1.30]: https://github.com/SummerSec/DeepSonar/compare/v0.1.29...v0.1.30
[0.1.29]: https://github.com/SummerSec/DeepSonar/compare/v0.1.28...v0.1.29
[0.1.28]: https://github.com/SummerSec/DeepSonar/compare/v0.1.27...v0.1.28
[0.1.27]: https://github.com/SummerSec/DeepSonar/compare/v0.1.26...v0.1.27
[0.1.26]: https://github.com/SummerSec/DeepSonar/compare/v0.1.25...v0.1.26
[0.1.25]: https://github.com/SummerSec/DeepSonar/compare/v0.1.24...v0.1.25
[0.1.23]: https://github.com/SummerSec/DeepSonar/compare/v0.1.22...v0.1.23
[0.1.21]: https://github.com/SummerSec/DeepSonar/compare/v0.1.20...v0.1.21
[0.1.20]: https://github.com/SummerSec/DeepSonar/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/SummerSec/DeepSonar/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/SummerSec/DeepSonar/compare/v0.1.17...v0.1.18
