# Governed Agent CLI Runtime Adapters

Issue #100 defines the boundary between Scheduler-owned execution policy and
provider-specific CLI protocols.

## Contract

`packages/runtime-sandbox/src/runtime-adapters.ts` is the single registry for
real Agent CLIs. Each registered adapter declares:

- a stable adapter id and installed CLI version;
- required capabilities (`streamEvents`, `controlMcp`, `completionGate`, and
  `sessionCapture`), plus optional incremental messaging and reasoning support;
- the governed runtime image keys on which it may run;
- a fixed command invocation and structured input/output codec.
- an explicit same-session resume operation when incremental stdin is not
  supported.

The adapter owns only protocol translation and provider configuration
materialization. The host still owns sandbox lifecycle, semantic control MCP,
event validation, completion gates, leases, and all state transitions. Output
is consumed as structured JSON events; terminal text is never scraped.

The current registry contains:

| Adapter | CLI | Protocol | Incremental messages |
| --- | --- | --- | --- |
| `claude-code` | Claude Code 2.1.220 | `stream-json` | yes |
| `codex` | Codex CLI 0.147.0 | `codex exec --json` JSONL | no |
| `open-code` | OpenCode 1.18.15 | `opencode run --format json` | no |

## Snapshot and admission

At Job creation, Scheduler resolves the adapter against the frozen runtime
image and stores `adapter_id`, `adapter_version`, and the complete capability
object in `agent_snapshot_json`. The executor passes that snapshot unchanged
to the sandbox runner. Runtime execution rejects a changed snapshot,
unregistered adapter, missing required capability, or incompatible image before
starting a CLI process.

The image manifests in `agent-harness/runtime-images.json` and
`agent-harness/kali-minimal-runtime.json` declare the installed CLI package,
version, and `agent_cli` identity. The Dockerfiles install those exact
versions, and `agent-harness/check-runtime-image-consistency.mjs` checks the
manifest/Dockerfile contract.

## Security boundaries

CLI commands are adapter-owned fixed invocations. User, task, and Agent input
is passed as data through the CLI's supported prompt or stdin interface; no
arbitrary command template is accepted. The existing host MCP control flow is
unchanged: only validated `tool_use`/`tool_result` pairs can release semantic
events, with bounded pending state and redacted telemetry. Provider credentials
remain outside the snapshot and are not emitted by adapter codecs.

## Verification

Contract tests cover registry admission, capability and image rejection,
Claude compatibility, Codex/OpenCode lifecycle normalization, tool completion,
and stdin behavior. Full local-docker CLI smokes additionally require the
corresponding provider credentials; credential-unavailable results must be
reported separately from adapter or parser failures.
