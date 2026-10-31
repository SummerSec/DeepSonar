# Governed Pi Observational Memory RPC Boundary

> 状态：切片 C 的运行时边界和定向单元测试已实现；真实 Pi/OM RPC 场景尚未执行通过。全局接线和验收由主协调者负责。
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
structured `gateway_transient` response with `effect_status=not_started`.
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
archives can bypass that export boundary. In
`apps/scheduler/src/domains/job-control/routes.ts`, both
`GET /jobs/:id/evidence/session` and `/jobs/:id/evidence/session/download` must
apply exported `redactPiObservationalMemoryText` to Pi content **before** preview
truncation or sending download bytes. Preserve their authorization, archive
selection and filename checks. This A/B-owned file was not modified here;
historical preview/raw-download closure remains pending. The Web projection
does not make an unsanitized HTTP download safe.

The new `packages/runtime-sandbox/src/pi-observational-memory.test.ts` needs a
root test-script entry, owned by global integration. Web model tests are wired
through `ci:unit:web-session-viewer`. The existing Pi image job calls
`agent-harness/test-pi-rpc.mjs`. No package scripts, lockfiles, schema, versions,
architecture views, DESIGN or indexes were edited in this slice.

## Offline real-RPC fixture and verification

The test harness starts the pinned Pi executable, canonical published OM source,
production wrapper and a local HTTP Gateway. Main/background credentials have
separate loopback routes. Requests record workload, model, stage and synthetic
usage; the harness does not register a custom fake `streamSimple` provider.
Docker uses `--network none`, with the listener and Pi in the same container.
Test-only path relocation does not add production bypass flags.

Eight scenarios cover actual observer/reflector calls, an original source over
1 MiB recalled through the bounded tool, hostile home/project/passive overrides,
same-session recovery, visible quota and pre-dispatch transient degradation
followed by native model compaction, permission/unknown/protocol failures,
private settings tampering, OM-disabled behavior, and strict stdout frames.
The fixture loads the production framer, parser, redactor and capture helper.
Run `node agent-harness/test-pi-rpc.mjs <built-image>`; a host run can set
`DEEPSONAR_PI_BINARY` to the installed Pi `dist/cli.js` and optionally
`DEEPSONAR_PI_OM_PACKAGE` to the canonical extracted package.

Recorded for this worker:

- The supplied canonical 3.1.4 tarball's SHA-512 matches the frozen integrity.
- 215 targeted tests passed on Windows with Node 24.14.0, including 18 OM
  boundary tests plus runtime recovery, driver/framing/capture and Web model
  tests. Wrapper unit doubles verify guards, not real plugin execution.
- Runtime TypeScript passed with explicit installed Node types and DOM libs.
  Web TypeScript passed with its normal project configuration. Standalone
  wrapper typecheck reports only the three unavailable image/host Pi imports.
- The real-RPC attempt failed before Pi started: `EPERM` while resolving the
  host npm `node_modules` directory. No real Pi frames, worker request counts
  or native fallback result were obtained. All eight real-plugin scenarios
  remain unverified here; the parent must retain their per-scenario counts.
- No SQL test, real provider call, deployment, commit or external write ran.

Documentation mapping for global review: FR-JOB-009 / FR-JOB-013,
NFR-SEC-003, NFR-EVO-003, IR-001 / IR-002 and CON-005 / CON-008. Reviewed entry
points were DESIGN sections 8-9, the architecture ownership table,
runtime/security views, document status index and trusted-kernel boundaries.
Their global updates remain with the main coordinator under this assignment's
ownership limit. Quality benefit and production behavior are unassessed.
