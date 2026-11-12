# OpenSandbox 1.2 upgrade and recovery boundaries

> 状态：**源码升级、受管资源声明预检与 provision 失败诊断已接线；当前组合待最终 SHA Actions**。历史验收、逐容器执行、远端/live/native 证据分别保留，不推导现场因果。
> 同步日期：2026-11-09

Verification baseline: the 2026-11-01 integration worktree, not a released or native-validated deployment. This updates [IR-001](architecture/01-system-specification.md#ir-001-scheduler-runtime-adapter-与-model-gateway) and [IR-003](architecture/01-system-specification.md#ir-003-opensandbox-与-worker-node) without changing Scheduler recovery or execution authority; see [runtime](architecture/06-runtime-view.md), [deployment](architecture/07-deployment-view.md) and [security](architecture/10-security-and-trust-boundaries.md).

Independent SDK provenance (historical): sibling worktree `DeepSonar-opensandbox-1.2`, branch `agent/opensandbox-1.2-upgrade`, clean main base `e219b53f1e4101b1b64fc97537c15f8eb582d87f` (2026-11-01). Only SDK/pin/config/tests/OpenSandbox documentation hunks were ported there from mixed source commit `7f9241f2373bb25f73f230ab7580eab19803678d`; no earlier ancestry, Plan, Finding research, authorization or Pi packaging changes were imported into that independent worktree. This does not describe the later integrated tree's scope.

## Managed Docker resource preflight (#1002 P2-11)

The first-party [development](../deploy/docker-compose.opensandbox.yml), [production](../deploy/docker-compose.opensandbox.prod.yml) and [Worker](../deploy/docker-compose.worker.yml) Compose files add an `opensandbox-resource-preflight` init dependency. It uses the same immutable server image and the same Engine socket source as the OpenSandbox service, not Scheduler's local Docker client or a remotely guessed endpoint. The [curated reader](../deploy/opensandbox/resource-preflight.py) issues only bounded, timed `GET /info`; it does not create or remove containers, change controllers or print Engine payloads/driver errors. It receives no Provider/Job credentials, uses no network, drops capabilities and mounts its script/socket read-only. A read-only socket mount is not an HTTP authorization boundary; the reader's fixed operation is the relevant restriction.

Explicitly disabled CPU quota/memory/PIDs, rootless cgroups v1 or the Engine warning that limits are unsupported produce `SANDBOX_RESOURCE_LIMITS_UNSUPPORTED`. Missing/non-boolean capabilities, unconfirmed rootless cgroup version, invalid/oversized replies, unavailable sockets or transport errors produce `SANDBOX_RESOURCE_LIMITS_UNKNOWN`. Both exit nonzero and prevent a normal dependency-respecting Compose start from admitting OpenSandbox; the existing Podman Scheduler `service_started` compatibility overlay does not weaken this `service_completed_successfully` dependency. Operators must configure a capable Engine/controller delegation, not raise Job ceilings or bypass the guard. There is no new skip flag or Agent decision.

This is an init-container declaration check, not proof of effective limits in each sandbox. A previously completed init can be reused by Compose; daemon/controller changes, unattended service restarts, explicit `--no-deps` starts, external OpenSandbox and Kubernetes are not continuously gated by this slice. See [remaining resource trust debt](architecture/12-risks-and-tech-debt.md#2-当前实现债务). The original ceiling/isolation requirements are not relaxed, and the check cannot make historical jobs `succeeded` or label unknown effects safe to replay.

Attention cost: one existing deployment failure path shows a stable reason and concrete Engine/controller action; no periodic notifications, additional settings or per-Job model prompt is added. Limits/read budgets remain code facts, not copied operational defaults.

The existing [runtime suite](../packages/runtime-sandbox/src/opensandbox-config-schema-gate.test.ts) invokes six stdlib rejection/transport/redaction tests inside the actual pinned server Python, a real hosted Engine read and a no-socket rejection. [Compose regressions](../packages/runtime-sandbox/src/opensandbox-deploy.test.ts) check image/socket identity and the mandatory dependency. `pnpm ci:unit:runtime-sandbox` is actually called by core CI; the unrelated isolated `load_config` parser implementation remains socket-free. Source and tests are written; final-SHA Actions/native/per-container proof is not inferred or yet claimed for this slice.

## Official sources and canonical pins

- Selected release: [official release-1.2.0](https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.2.0). The [fixed official BOM](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.0/docs/releases/1.2.0.yaml) is the version/image source, not a mutable execution tag. Re-read on 2026-11-01: releaseDate 2026-10-27, gitCommit `25873227f60424bdc59bfa83b963bbc00e871297`; server/execd/egress pins match the BOM.
- The exact SDK version and immutable server/execd/egress OCI index references are owned by [version facts](../packages/runtime-sandbox/src/opensandbox-version.ts). Installation and dependency closure are owned by [runtime package](../packages/runtime-sandbox/package.json) and [lockfile](../pnpm-lock.yaml); do not duplicate digests here. Upgrade SDK/package/lock/config/Compose/fixtures/gates together, not just one constant.
- Installed package inspection on 2026-11-01: SDK 1.2.0, Apache-2.0, Node >=20, ESM/CJS. The SDK requires `undici ^7.30.1`; the existing direct undici declaration is unchanged. See the [fixed npm version](https://www.npmjs.com/package/@alibaba-group/opensandbox/v/1.2.0); resolved versions/integrities remain lockfile facts. This is metadata, not a security audit or native compatibility result.
- [SDK binding](../packages/runtime-sandbox/src/opensandbox-sdk-client.ts) rejects an installed-version/pin mismatch. Matching BOM digests and runnable amd64/arm64 descriptors checked in the Root integration prove artifact identity/availability, not native execution. Registry descriptors and native execution were not revalidated in the independent SDK worktree.

## Unchanged deployment and kernel boundaries

1. The repository [Docker](../deploy/opensandbox/config.toml), [Kubernetes](../deploy/opensandbox/config.k8s.toml) and [external-cluster](../deploy/opensandbox/config.k8s.external.toml) deployment profiles remain `ingress.mode=direct`. The new pin does not enable gateway. `OPEN_SANDBOX_USE_SERVER_PROXY` controls the existing execd access path; it is not ingress gateway or Scheduler-owned Model Gateway.
2. Any future gateway evaluation needs independent nested `[ingress.gateway]` address and `[ingress.gateway.route]` mode preflight, pinned-server parsing and target-backend/route validation. Existing [structural/schema checks](../packages/runtime-sandbox/src/opensandbox-config-schema-gate.ts) are not proof that every backend supports or successfully runs gateway. This upgrade makes no unsupported-backend assertion inherited from 1.1.
3. Docker retains bridge networking, `drop_capabilities=[ALL]`, `no_new_privileges=true` and existing resource limits. Kubernetes retains Kata/BatchSandbox, PVC policy and resource governance. DNS egress, disabled IPv6, storage policy and `renew_intent.enabled=false` remain configuration facts. No new privileged/host-path permissions or global create-time isolation are enabled.
4. Historical SDK 1.1 Job pins are not rewritten/rebound to 1.2; installed-version mismatch fails closed. No database schema change is made. Create still forwards frozen resources/network/volumes with `timeoutSeconds=null`. Scheduler owns Job deadline, Attempt/effect, lease, cancellation, cleanup and unknown effects. No new SDK lifecycle/autoPause/Vault integration, knobs, session reuse or execution channel is introduced.
5. SDK 1.2 enables wake retries by default for a 503 carrying `OpenSandbox-Wake: expired`; that upstream marker is not platform effect-settlement authority. [Connection construction](../packages/runtime-sandbox/src/opensandbox-sdk-client.ts) explicitly sets `wakeRetryEnabled=false`, disables metrics and keeps the existing proxy and 180-second timeout. Create, connect and upload transport replacement must not silently opt into replay. Existing Scheduler-owned bounded recovery and upload classification remain. `withTransportIfMissing()` clones and owns operation transports for an uninitialized ConnectionConfig; caller-initialized configs are borrowed and remain caller-owned. The client singleton stays uninitialized. Upload recycling closes the previous local transport and supplies a genuinely new uninitialized ConnectionConfig to `Sandbox.connect`, preserving those connection policies without killing/recreating the remote sandbox or blindly pre-initializing with `withFreshTransport()`.
6. The installed SDK public declarations inspected on 2026-11-01 expose no first-class PTY or extraHosts/hostAliases API. [Execd WebSocket PTY mapping](../packages/runtime-sandbox/src/opensandbox-pty.ts) and [hosts binding](../packages/runtime-sandbox/src/opensandbox.ts) remain DeepSonar-owned. Frames, endpoints/headers, Docker Engine injection, Kubernetes create-only isolation and guest USER are unchanged.

### PTY 退出与中断的区分（#1088）

[Execd WebSocket PTY 映射](../packages/runtime-sandbox/src/opensandbox-pty.ts) 只把合法退出帧（`type=exit` 且 `exit_code` 为 0..255 安全整数）映射为 CLI 退出码；缺失或非法 `exit_code`、WebSocket `close`/`error`、宿主主动 `kill` 都归为传输异常 `OPENSANDBOX_PTY_TRANSPORT_CLOSED`，随现有 runner → Evidence 链落库的有界证据是退出帧投影、关闭码/原因/`clean` 标记与脱敏错误原因，不再伪造成 `exit 1`/`exit 0`。该诊断只用于事后区分「CLI 真实退出 / OOM / 传输中断」，不授予重连、CLI 重开或未知效果重放；断裂会话仍按既有失败收口与人工补跑流程处理。

## Provision 失败诊断（#1002）

[OpenSandbox adapter](../packages/runtime-sandbox/src/opensandbox.ts) 在正常失败清理前提供宿主 callback，阶段为 create、runtime contract、shared assets、runtime manual 或 gateway；[Dispatcher](../apps/scheduler/src/dispatcher.ts) 通过现有 [audit sink](../apps/scheduler/src/audit.ts) 追加 `job.provision_failed`，使用 `deepsonar.provision-failure/v1` 关联当前 Job/Attempt。只保存是否观察到会话、是否取消、合法 HTTP 状态及 execd distribution、broken pipe、connection reset、timeout 的固定布尔信号；不保存任意 provider code/message、响应 body、堆栈、Job env 或 capability token。

#1002 P2-10 补清理前诊断的 Job 读面：在原 Job → Attempt 锁内，首次 `job.provision_failed` append-only 审计与 `state_json.provision_failure_audit_id` 引用同事务发布；重复 callback 保留第一份证据，不修改状态、phase、effect、快照、预算或 replay policy。相交的单 Job 取消同样先锁 Job 再锁 Attempt；真实双连接/barrier 回归要求两条路径等待 Job 时尚不持有 Attempt，并验证两种先后均完成取消、只写一次诊断及 unknown/never 语义。`GET /jobs/:id` 的 `provision_diagnostics` 仅按现有 `tasks:read` 项目/Job 权限读取，按引用做主键查询，再核 scheduler/system 来源、项目、Job、Attempt、schema 和固定形状。审计 text 归属比较使用数据库返回的规范 Job ID，大小写 UUID URL 读取相同诊断。只投影时间、来源、stage/status/布尔信号，不扩展审计权限，不返回 audit 元数据、SDK/body/env 或容器日志；预算见 [实现](../apps/scheduler/src/provision-failure-evidence.ts)。无引用或非法/外来引用不猜测回填，旧 audit 仍走原审计渠道。

审计引用只是诊断来源，不是第二个 effect/恢复状态。正常失败路径等待持久写入后再沿用现有清理；写入失败只记录固定宿主提示，继续清理并抛出原错误。SDK 或取消路径可能已先清理资源，不能承诺取得 server/execd 原始日志，也不保留可能含凭据的失败容器。`session_observed=false` 不是 no-start；已经尝试 create 的未知效果、迟到资源和取消 fencing 仍按原生命周期处理，不扩大预算、重试 create 或推断降低并发已解决问题。

| 注意力成本 | 自动处理 | 保留给人的判断 |
| --- | --- | --- |
| 单次失败排障 | 在既有审计中保存固定诊断，随原 Job 详情提供有界读回，维持清理；不新增通知、设置或工作流 | 结合确切 Attempt、镜像、Engine/execd 证据确认现场根因；信号存在不等于因果已证实 |

回归接线：`pnpm ci:unit:runtime-sandbox` 覆盖非秘密信号、getter 拒绝、正常清理前 callback、审计失败不遮蔽原错误、成功不记录、取消及迟到资源；`pnpm ci:unit:scheduler-characterization` 核对 durable audit 与未知 create 的 source wiring。现有 `pnpm ci:integration:dispatch-limits` 保留真实持久 effect 的 no-start/unknown 区分。[清理前 SQL/HTTP 读回回归](../apps/scheduler/src/provision-failure-evidence.integration.test.ts)接现有 `pnpm ci:integration:platform-api`，验证原 runner callback → audit/引用同事务 → cleanup 内实际 Job GET 可读、首次证据不覆盖、原 effect 不变、无 handle/取消、SQL rollback 与失败仍清理、外来/坏引用/非 scheduler 来源拒绝及固定投影脱敏。Provider 是受控替身，不是实机 Engine。此改动未在本机执行测试，最终候选 Actions 待验；这些替身/源码检查不证明现场 Podman 并发因果、丢失的 execd 日志或容量收益。

## Verification layers and remaining proof

| Layer | Source gate | Evidence boundary |
| --- | --- | --- |
| SDK/install | [SDK regression](../packages/runtime-sandbox/src/opensandbox-sdk-client.test.ts), [pin regression](../packages/runtime-sandbox/src/opensandbox-version.test.ts); `pnpm ci:unit:runtime-sandbox` | Actual installed SDK ConnectionConfig constructor is captured through mocked create/connect before network; `wakeRetryEnabled=false`, metrics/proxy/180-second timeout, `withTransportIfMissing()` clone/borrow, owned-manager closure and genuinely-new upload replacement are checked. Not live-server proof. |
| Config/isolation | [Schema regression](../packages/runtime-sandbox/src/opensandbox-config-schema-gate.test.ts), [deploy regression](../packages/runtime-sandbox/src/opensandbox-deploy.test.ts); same runtime unit entry | Lightweight structure checks differ from running `load_config` in the immutable server image. Genuine Docker-unavailable skips are not successful parsing; CI requires available Docker. |
| PTY protocol | [PTY regression](../packages/runtime-sandbox/src/opensandbox-pty.test.ts); same runtime unit entry | Offline frame/pipe/cancel/backpressure checks do not prove actual new server/execd PTY, exit code or cleanup. |
| Live/native | [OpenSandbox harness](../agent-harness/test-opensandbox-poc.ts), `pnpm ci:smoke:opensandbox`; [Reverse native workflow](../.github/workflows/reverse-runtime.yml) | Requires exact images, real Job and separate native-platform execution logs. BOM/descriptor checks and QEMU are not native runs. |
| Final combination | [Core CI](../.github/workflows/ci.yml), docs/file-size and applicable native gates | Wiring is not exact final-SHA success or release approval. |

### Historical Root integration local verification

2026-11-01 Lead-owned local verification: the full root runtime unit command passed **362 tests with 6 genuine Docker-schema skips** because no daemon was available, including the installed-constructor `wakeRetryEnabled=false` regression. Do not add the earlier focused 84-pass/6-skip subset to this denominator. Full typecheck, frozen installation, documentation freshness and file-size gates returned 0. Local `ci:images` passed the Pi identity/packaging tests after a canonical-path fixture correction and completed manual/catalog/platform/OCI/hdc structural checks, but stopped at Mobile help smoke because `qemu-x86_64-static` is unavailable on this macOS host; the remaining chained image checks were not run. This is a failed/incomplete local image command, not an accepted skip or full image-gate pass. At this historical local checkpoint, exact final-source CI, pinned-server parsing and native execution remained pending.

### Historical independent SDK local verification

2026-11-01 checks run in the independent SDK worktree using the primary Node v24.21.0 / pnpm@9.15.9 runtime:

- Frozen local install with --ignore-scripts returned 0 and did not modify the ported lockfile. Shared-types/runtime-manual-contract/runtime-sandbox builds returned 0.
- Full `pnpm ci:unit:runtime-sandbox`: 333 passed, 0 failed, 6 genuinely skipped Docker image-schema cases (no daemon). Includes installed SDK clone/borrow ownership, new upload config, pins, offline PTY/deployment/resource policies. This is not native/live proof.
- `pnpm ci:unit:runtime-cleanup`: 83 passed, 0 failed, 1 database-dependent skip (TEST_DATABASE_URL unset).
- Whole-workspace `pnpm typecheck` returned 0. Full `pnpm build` returned 1 at the macOS Rollup native module: process/module Team IDs differ. No signature stripping or toolchain bypass was attempted.
- `pnpm ci:images` returned 1 after runtime-manual, image consistency, control-plane platform, OCI-size and hdc checks passed: Mobile apkcheckpack help needs unavailable qemu-x86_64-static. Later Reverse/native/web chained checks did not run.
- Documentation freshness and file-size gates each passed 10 tests, 0 failed; the former was rerun after fixing a numeric package-manager version mistaken for a script name. Manual review matched affected IR-001/003, source facts, policy and evidence boundaries; no new requirement/ADR or schema change is needed.


2026-11-01 first standalone CI failed before SDK/native execution: core run 41240763331 and Reverse run 41240763357 hit a stale static Reverse version oracle (expected historical v0.6.0; main catalog declares published v0.6.2). A separate test-only prerequisite carries the already-existing #831 fix: select the catalog's published platform version, require its canonical immutable digest and retain both-platform/all-channel evidence equality. No catalog, release metadata, runtime or history is rewritten. New exact-head hosted results still require verification.

After prerequisite `fd9e03ad`, core run 41242465411 passed `ci:images` but stopped at runtime-image registry unit step 9: 135 passed, 1 failed, 0 skipped because the bundled Reverse admission fixture still expected historical v0.6.0 rather than published v0.6.2. A second test-only prerequisite updates [that fixture](../apps/scheduler/src/reverse-runtime-project-opt-in.test.ts) to require exactly one published-version row and bind canonical refs, dual platforms and all channel evidence to its canonical digest. Fixed ACR namespace and all readiness/project-opt-in/schema/manual/default/negative assertions remain unchanged; no production catalog or runtime edit.

2026-11-01 local prerequisite verification: worker direct execution of the exact wired 12-file runtime-image test list passed 136, with 0 failed / 0 skipped (no scripted prebuild in that worker run). Lead independently reran the literal `pnpm ci:unit:runtime-images` entry including all scripted builds: exit 0, 136 passed / 0 failed / 0 skipped; target 8 passed; Scheduler typecheck, definition, docs and file-size checks returned 0. Additional `pnpm ci:unit:runtime-registry` returned 1: earlier generator/reuse passed, catalog-platform tests reported 72 passed / 6 failed because local Bash 3.2 lacks `mapfile` (status 127, not expected 0/1); remaining chained publication/evidence checks did not run. No toolchain or assertion bypass was applied. These local results are not new exact-head hosted/native acceptance.

Historical SDK 1.1 results, including [Reverse run 41221081653](https://github.com/SummerSec/DeepSonar/actions/runs/41221081653), do not establish SDK 1.2 behavior. The Root **362 passed / 6 Docker-schema skips** and independent SDK **333 passed / 6 Docker-schema skips** above remain separate historical local scopes; neither is rewritten as a Docker pass or added to the other denominator. Their local evidence does not establish live/native execution, actual PTY or final combined CI.

### Exact-checkout hosted pinned-server parsing

Separate hosted evidence: [SDK core run 41261242118](https://github.com/SummerSec/DeepSonar/actions/runs/41261242118), [gate job 124714820191](https://github.com/SummerSec/DeepSonar/actions/runs/41261242118/job/124714820191), actually checked out `58c37966451344ff5476caaaf72bb338fa9a9242` (parents main `e219b53f1e4101b1b64fc97537c15f8eb582d87f` and SDK `6f4cac99dd3ca3d9c1b258221693a1f8d3c1d2e6`). The 2026-11-01 **01:42:54 UTC** execution log records all six Docker pinned-server parser cases actually passing, without skips:

1. Docker direct default config accepted.
2. Docker gateway without its gateway block rejected.
3. Kubernetes gateway fixture with address and `route.mode` accepted.
4. Kubernetes gateway missing its address rejected.
5. Kubernetes gateway missing `route.mode` rejected.
6. Both deployed Kubernetes direct configs accepted in the same case.

[Version facts at that checkout](https://github.com/SummerSec/DeepSonar/blob/58c37966451344ff5476caaaf72bb338fa9a9242/packages/runtime-sandbox/src/opensandbox-version.ts), blob `2b804f2eb309dbf808d995815374c72ed46d9e2d`, were checked against SDK 1.2.0 and the immutable server digest in the selected official release BOM (`25873227f60424bdc59bfa83b963bbc00e871297`). The [source gate](../packages/runtime-sandbox/src/opensandbox-config-schema-gate.ts) runs the pinned image's `load_config` with a read-only TOML mount and no network; these are actual configuration-parser results, not just the lightweight structural assertions.

This closes pinned-server configuration parsing for that exact checkout and selected server image only. It does not prove gateway backend capability, live Sandbox or actual PTY/native-platform execution, production/model acceptance, a final release, or CI on the later Root/SDK combined HEAD; those results must bind their own checkout, immutable images and execution logs.

Production/model execution is not authorized by this document. Existing production-execution exemption does not turn unknown effects, non-model gates or missing independent quality inputs into passed acceptance. Historical [ARCHITECTURE](ARCHITECTURE.md), [release-readiness record](RELEASE_READINESS_POST_v0.4.4.md) and [CHANGELOG](../CHANGELOG.md) version facts are preserved.
