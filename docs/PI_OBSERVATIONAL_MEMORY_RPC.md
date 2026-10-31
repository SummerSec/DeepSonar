# Governed Pi Observational Memory RPC Boundary

> 状态：本地构建 base 镜像的 canonical Pi/OM 真实 RPC、独立生产启动守卫正负例及定向回归已通过；最终组合 CI 与发布镜像证据待完成。
> 同步日期：2026-10-31

This slice integrates the pinned `pi-observational-memory@3.1.4` source with
Pi 1.4.0. Memory is session context, never a DeepSonar Fact, independent
Evaluation, or permission to submit semantic control events.

## Canonical entry and frozen configuration

The Scheduler's literal-config loader calls
`createGovernedObservationalMemoryExtension(frozenConfig)` from:

```text
/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts
```

The wrapper invokes the actual published entry, without reimplementing memory:

```text
/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory/src/index.ts
```

It validates the frozen `deepsonar.pi-observational-memory/v1` identity, npm
integrity, provider/model, thinking, thresholds and immutable flags. The only
worker route is `__deepsonar_observational_memory` with the frozen model id.
The source provider/model fields are audit metadata. Main-session model
context remains available to the upstream compaction-ratio calculation.
Pi starts with `--no-extensions` and the explicit governed loader.

New Job admission checks OM's extension-specific image-version requirement
against the Scheduler-selected catalog entry; see
[`pi-extensions.ts`](../apps/scheduler/src/pi-extensions.ts). Missing, malformed
or older image metadata fails closed. Runtime startup also checks the installed
canonical package, entry and wrapper before starting or resuming Pi RPC and
before the first prompt; see
[`pi-memory-image-guard.ts`](../packages/runtime-sandbox/src/pi-memory-image-guard.ts)
and [`runtime-adapters.ts`](../packages/runtime-sandbox/src/runtime-adapters.ts).
The production guard has passed installed/missing-content Docker checks;
adapter regressions prove a failed guard prevents `runAsync`/RPC startup.

The wrapper creates a private settings directory and project root for each Pi
process. While invoking the synchronous portion of an upstream callback, it
points `PI_CODING_AGENT_DIR` at the private settings and removes
`PI_OBSERVATIONAL_MEMORY_PASSIVE`. Both environment values are restored before
any await. OM sees the private configuration cwd; Pi and other extensions keep
their original environment and session paths. Home/project settings and the
passive environment override cannot resolve OM configuration.

Each lifecycle/tool call checks the private settings bytes, frozen model
route, bound session id/file and sticky failure state. Settings drift fails
closed. Session switches and forks are cancelled. A new process revalidates the
same Job snapshot and resumes the exact Pi session file; it does not re-resolve
OM from mutable current settings. Job ownership and persistent allowance
remain Scheduler/Gateway responsibilities.

Finite budgets require explicit positive main/background allocations whose
sum does not exceed the frozen total. The wrapper derives no percentage or
implicit reservation. Omission preserves the platform's unlimited default.

## Background errors and settlement

OM 3.1.4 catches errors inside its background consolidation task. An outer
lifecycle try/catch alone cannot enforce hard failures. The wrapper observes
real worker stream events and tracks the canonical
`Runtime.launchConsolidationTask` promise. That method is adapted only during
synchronous callback invocation and immediately restored. The
`agent_before_settle` guard waits for those actual tasks and checks the sticky
failure, including errors swallowed upstream.

Expected degradation accepts only the Gateway's exact quota response, or a
structured `gateway_transient` response with `effect_status=not_started` backed
by a known pre-request transport result. A provider 5xx or error prose alone is
not proof that the external effect never started.
These sanitized status codes can leave the wrapper:

```text
PI_OM_WORKER_QUOTA_EXHAUSTED
PI_OM_WORKER_TRANSIENT
```

An expected failure disables OM lifecycle/compaction overrides for the rest of
that process and sends one generic `deepsonar.om.status` custom message. The
host projects it to `runtime.diagnostic`, with `fallback=native_compaction`.
It is not a Fact or control receipt. A resumed process can attempt workers
again only through its current Gateway allowance and reconciled usage.

Permission, model, configuration, integrity, protocol, incomplete streams and
unknown external effects remain sticky hard failures. In particular,
`workload_usage_unknown` and `workload_usage_pending` require reconciliation.
A bare HTTP 5xx does not establish that no external effect occurred. Every
`extension_error` stays hard, even when its text contains a worker marker.
The OM-enabled host also rejects Pi's extension-loader error on stderr before
starting a prompt, including a diagnostic split across process chunks.
The worker model, route and response identity are checked. Gateway auth must
be present; the wrapper cannot fall back to an ambient provider credential.

## Output boundaries

The browser-safe field policy is owned by
[`shared-types/pi-observational-memory-redaction.ts`](../packages/shared-types/src/pi-observational-memory-redaction.ts).
Runtime capture, historical archive reads and the Web viewer import that same
policy. The Node process-stream adapter remains in
[`runtime-sandbox/pi-observational-memory.ts`](../packages/runtime-sandbox/src/pi-observational-memory.ts).
The isolated Web image builds from its declared Web/shared-types context; it
requires no runtime-sandbox source copy. Runtime/Web regressions, archive reads
and all image RPC scenarios passed again after this ownership change.

| Exit | Removed | Preserved |
| --- | --- | --- |
| `om.observations.recorded`, `om.reflections.recorded`, `om.observations.dropped` | Memory prose | Entry/custom type, coverage/support/source ids and counts |
| `om.folded` compaction | Folded summary, observations and reflections | Compaction identity and native compaction behavior |
| `recall` | Rendered text and nested memory/source content, including `details.sourceEntries[].content` | Tool/call identity, memory ids, status and source metadata |
| Session export and viewer | The same memory fields, including JSONL inside a text payload | Session/archive identity and artifact paths |
| Large RPC workspace/evidence copies | Memory before either write | Complete control identities, framing and redacted hash scope |
| stderr and telemetry | Split/pretty OM JSON, nested JSONL and recognized OM diagnostics | Ordinary diagnostics when OM is disabled |

Recall is bounded inside the wrapper before Pi serializes its output. Text
fields are at most 16 KiB, arrays at most 32 items, and the result at most
128 KiB. Truncation marks the result partial. Oversized results retain a bounded
source metadata/content projection and memory identity. Reused array references
do not erase source/support ids. Renderers receive a second redacted projection.
The upstream `/om:view` clipboard export is replaced by a generic notice.

Pi 1.4.0 has `hasUI=true` in RPC mode; `ui.notify` creates
`extension_ui_request`. OM's notification subprotocol is suppressed in RPC
mode. Status uses the ordinary message API above, without a new model turn.
The explicitly admitted official `entry_appended` frame exposes only OM ledger
identity to normalized telemetry. Unknown frames, invalid JSON/UTF-8,
oversized frames and truncated frames still fail closed under #765.

A different extension's tool named `recall` remains unchanged unless its result
has the published OM details shape. Native compaction is not classified as OM
from its event name alone. Stderr line buffering is enabled only for the frozen
OM extension. Oversized incomplete diagnostics discard the rest of that process
stream and reset at the next process boundary.

## Hooks owned by global integration

New Pi exports and large RPC copies are sanitized before storage. Historical
archives now use the same structured projection in
`apps/scheduler/src/domains/job-control/routes.ts`; both
`GET /jobs/:id/evidence/session` and `/jobs/:id/evidence/session/download` apply
exported `redactPiObservationalMemoryText` to Pi content **before** preview
truncation or sending download bytes. The immutable archive metadata remains the
source identity; projection bytes/SHA are reported separately and download
returns `x-deepsonar-session-projection` plus a Content-Digest for projected
bytes. Preserve authorization, archive selection and filename checks. The
2026-10-31 session-memory integration and evidence-session checks passed for
mixed CLI headers, a large canary, immutable source bytes, traversal and native
quoted content. These checks cover the structured HTTP exits and preserve the
original archive identity.

The runtime-sandbox unit entry and global test wiring are owned by the mainline
integration. Web model tests are wired through `ci:unit:web-session-viewer`.
The existing Pi image job calls `agent-harness/test-pi-rpc.mjs`. Its wiring is
separate from the actual local built-image acceptance recorded below.

## Offline real-RPC fixture and verification

The test harness starts the pinned Pi executable, canonical published OM source,
production wrapper and a local HTTP Gateway. Main/background credentials have
separate loopback routes. Requests record workload, model, stage and synthetic
usage; the harness does not register a custom fake `streamSimple` provider.
Docker uses `--network none`, with the listener and Pi in the same container.
Image proof checks the installed package/lock identity, tool manifest,
wrapper hash and Pi version without mounting a replacement plugin or wrapper.
It imports the installed production wrapper directly. Only the separately
labelled host branch relocates the wrapper to a canonical temporary package;
that result is never image evidence.

Eight scenarios cover actual observer/reflector calls, an original source over
1 MiB recalled through the bounded tool, hostile home/project/passive overrides,
same-session recovery, visible quota and pre-dispatch transient degradation
followed by native model compaction, permission/unknown/protocol failures,
private settings tampering, OM-disabled behavior, and strict stdout frames.
The fixture loads the production framer, parser, redactor and capture helper.
Run `node agent-harness/test-pi-rpc.mjs <built-image>`; a host run can set
`DEEPSONAR_PI_BINARY` to the installed Pi `dist/bundle/cli.js` and optionally
`DEEPSONAR_PI_OM_PACKAGE` to the canonical extracted package.

Historical C-slice worker record (not the later mainline host verification):

- The supplied canonical 3.1.4 tarball's SHA-512 matches the frozen integrity.
- 215 targeted tests passed on Windows with Node 24.14.0, including 18 OM
  boundary tests plus runtime recovery, driver/framing/capture and Web model
  tests. Wrapper unit doubles verify guards, not real plugin execution.
- Historical C-slice checks reported Runtime TypeScript and Web TypeScript
  passing under their local setup; its standalone wrapper typecheck only exposed
  the three unavailable image/host Pi imports. That was a local/old-slice
  limitation, not a blanket unresolved dependency conclusion for current root
  code; mainline S3/runtime build and Scheduler/Web checks are recorded below.

主线既有核验记录（2026-10-31；以下是主线提供的证据，本轮文档同步 worker 未执行这些验证）：

- 主线使用已安装 Pi 1.4.0 与临时固定的 npm
  `pi-observational-memory@3.1.4` 完成八个真实插件场景：`success` 记录 5 个
  main / 16 个 background（8 observer、8 reflector）；quota 与已知请求前
  transient 走可见的 native compaction fallback；permission、unknown-effect、
  protocol 保持硬失败，并覆盖 config drift 与 disabled。完整原始日志为临时
  `pi-real-rpc.stdout.log`，夹具为 `agent-harness/fixtures/pi-om-real-rpc.mjs`。
- 安装宿主结果只证明 host Pi/package/wrapper 组合，保留为独立历史证据；本地构建镜像的直接运行结果见下一节。
- Runtime.js module identity 与 SDKHTTP 冒号/innerJSON 分类已修复；22 个 wrapper
  tests 通过，且没有请求真实模型。
- 主线的 S3 类型/runtime build 与 Scheduler/Web TypeScript 检查通过；这只是类型/构建
  证据，不是外部 S3 存储或生产验收。后续 host/session/Gateway 结果同样是主线既有
  证据，不追归为历史 C 片 worker 执行。

## 2026-10-31 主线程 BUILT-IMAGE 验收

本节集中记录主线程实际执行并提供日志的镜像证据；文档整理未重跑构建或 RPC。
核验对象是 `c0b5e345` 加验收时的根工作树 WIP，包含尚未提交的生产启动守卫与
镜像 harness，不能把结果描述为仅该 commit 的完整验收。

`deploy/Dockerfile.agent` 的 `TOOLSET=base` 实际构建退出 0，唯一 local tag 为
`deepsonar-base:815-main-1793451806`，Docker image ID 为
`sha256:620bcc944d102a4a0bee60a5082b112bffea655a30f4f9b7918dc1543cbc9930`。
这是本地 image ID，不能用作已发布 OCI manifest 或 catalog digest。原始证据在
`C:\Users\sin\AppData\Local\Temp\deepsonar-work` 的
`815-main-image-build-status.json` 与 `815-main-image-build.stderr.log`。

主线程以 `--network none --read-only` 实际运行该镜像的已安装 Pi 1.4.0、canonical
OM 3.1.4 和生产 wrapper；未挂载替换包或 wrapper，也未 relocation。wrapper SHA-256 为
`260a7a439d692f040ca9a28fae68037009bc22c53ccb012db124278df1d34f59`。
[`pi-image-packaging.mjs`](../agent-harness/pi-image-packaging.mjs) 在启动 loopback
Gateway 前核对实际 package-lock 的 canonical URL/SHA-512、包名称/版本/MIT/entry、
tool manifest self-hash/wrapper hash，以及 Pi owning manifest 的 bin/version。
Pi canonical bin 是 `dist/bundle/cli.js`；已修正原先假定 bin 只在包下一层的 helper，
并加入 owning-manifest 与精确 bin 身份回归，封装 helper 测试 8/8 通过。

镜像内 RPC 日志 `815-built-image-rpc.stdout.log` 与状态
`815-built-image-rpc-status.json` 记录 `rpc_exit=0`、全部八场景通过：

| 场景 | main 请求 | background 请求 | 结果 |
| --- | --- | --- | --- |
| success | 5 | 16（8 observer、8 reflector） | 真实 worker、恢复、配置隔离、有界 recall 与严格帧通过 |
| quota | 2 | 1 | 可见降级后 native compaction |
| transient | 2 | 1 | 已知未开始响应后可见降级 |
| permission | 1 | 1 | 硬失败 |
| unknown | 1 | 1 | 硬失败 |
| protocol | 1 | 1 | 硬失败 |
| config-drift | 0 | 0 | 出站前拒绝 |
| disabled | 2 | 0 | 主会话不受影响，无后台请求 |

生产启动守卫来自上文 `pi-memory-image-guard.ts` 的 `PI_MEMORY_IMAGE_GUARD_SOURCE`，
由 `runtime-adapters.ts` 在 Pi 启动/恢复前执行。主线程将同一 guard JS 在该实际镜像中
以 `--network none --read-only` 运行，独立于封装预检取得下列结果：

| 镜像内容 | 退出码 | 输出 |
| --- | --- | --- |
| 已安装包、entry、wrapper | 0 | `PI_OM_RUNTIME_IMAGE_READY` |
| 空插件目录 mount | 78 | `PI_OM_RUNTIME_IMAGE_CONTENT_INVALID` |
| 空 wrapper mount | 78 | `PI_OM_RUNTIME_IMAGE_CONTENT_INVALID` |

日志为同一临时证据目录的 `815-image-guard-{installed,missing-package,missing-wrapper}.*.log`。
`runtime-adapters.test.ts` 的 55 pass/0 skip 证明 guard 失败时 `runAsync`/RPC 不启动，
关闭 OM 的路径不受影响。它与实际 Docker guard 正负例共同支撑运行时拒绝结论，
封装 helper 的单元负例本身不作生产拒绝证据。

新 Job 的 OM 专属版本下限取自
[shared registry](../packages/shared-types/src/pi-extensions.ts)，由
[`freezePiExtensions`](../apps/scheduler/src/pi-extensions.ts) 的第五参数接收
[快照调用方](../apps/scheduler/src/domains/role-runtime-snapshot/application.ts)
选定的 `runtimeImage.image_version`。缺失、非法或旧 metadata fail closed；
非 OM 扩展及全局下限不变，历史快照保持冻结字节。扩展/角色快照回归 31 项通过。

`run-815-built-image-acceptance.ps1` 最初因旧同步抛错断言而中断，不能计作整条组合通过；
主线程修正异步拒绝断言后分别重跑适配器回归和上述实际 Docker RPC 并通过。
内核已知请求前 transport/持久结算及 provider 防冒充证据见
[Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md)，不与 RPC 计数相加。

最终当前 PR 远端 CI、合并后最终 main CI、发布通道/平台镜像与 registry/catalog 证据尚未完成。
本地 base 镜像结果不证明所有镜像/平台，也不改写已发布 v0.6.2 的不可变 digest。
外部 S3 存储未实测；质量、价格/成本收益、容量与 SLA 保持 `unknown`。

Documentation mapping: FR-CAP-009, FR-IMG-003, FR-JOB-009 / FR-JOB-013,
NFR-SEC-003 / NFR-SEC-004, NFR-EVO-003, IR-001 / IR-002 and CON-005 / CON-008.
