# Changelog

Release entries are maintained from verified tag and repository changes. The immutable `vX.Y.Z` Git tag is the product release version. Root and workspace package versions remain private internal package metadata (`0.1.11`) and are not release identifiers.

## [Unreleased]

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
