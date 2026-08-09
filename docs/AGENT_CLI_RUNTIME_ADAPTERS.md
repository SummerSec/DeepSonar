# Governed Agent CLI Runtime Adapters

Issue #100 defines the boundary between Scheduler-owned execution policy and
provider-specific CLI protocols.

## Contract

`packages/runtime-sandbox/src/runtime-adapters.ts` is the single registry for
real Agent CLIs. Each registered adapter declares:

- a stable adapter id and installed CLI version;
- required capabilities (`streamEvents`, `controlMcp`, `completionGate`,
  `sessionCapture`, and `contextCompaction`), plus optional incremental
  messaging and reasoning support;
- the governed runtime image keys on which it may run;
- a fixed command invocation and structured input/output codec.
- an explicit same-session resume operation when incremental stdin is not
  supported.

The adapter owns only protocol translation and provider configuration
materialization. The host still owns sandbox lifecycle, semantic control MCP,
event validation, completion gates, leases, and all state transitions. Output
is consumed as structured JSON events; terminal text is never scraped.

The current registry contains:

| Adapter | CLI | Protocol | Incremental messages | Context policy | Structured reasoning |
| --- | --- | --- | --- | --- | --- |
| `claude-code` | Claude Code 2.1.220 | `stream-json` + governed `--include-partial-messages` | yes | Automatic compaction; defaults `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to `70`, with an explicit environment value taking precedence | `stream_event` thinking/text deltas and complete assistant blocks |
| `codex` | Codex CLI 0.147.0 | `codex exec --json` JSONL | no | Codex's documented built-in automatic-compaction default; no unsupported adapter flag is added | Official reasoning summary/item events when emitted |
| `open-code` | OpenCode 1.18.15 | `opencode run --format json --thinking` | no | Materialization defaults `compaction.auto` to `true`, preserving explicit values and all other compaction keys | Structured `reasoning`/`thinking` parts when emitted |

All three adapters declare `contextCompaction: true` and are admitted only when
the context policy is supported. Claude and OpenCode do not rely on the Codex
policy or receive the Claude-specific environment variable.

## New adapter onboarding checklist

Every new CLI must declare and test automatic context compaction before it can
be registered or admitted:

1. Add `contextCompaction: true` and document the exact upstream or adapter
   policy, including defaults and explicit overrides.
2. Add adapter tests that exercise the automatic-compaction behavior and verify
   that unsupported provider flags or environment variables are not injected.
3. If the upstream CLI has no automatic compaction, the adapter must implement
   a bounded summary/new-session handoff and declare the
   `bounded-session-summary` policy.
4. Do not admit the adapter until the declaration, tests, and bounded-session
   behavior (when needed) are complete.

`reasoningEffort` is an input/configuration capability; it does not guarantee
that a provider exposes its internal reasoning in output. The runtime only
normalizes an explicitly structured reasoning event (`reasoning.delta`) and
never infers or fabricates reasoning from ordinary text, tool output, or
terminal lines. If the selected CLI/model does not emit a supported reasoning
event, the live and archived stream simply contains no reasoning block.

Claude partial frames are enabled only for the pinned 2.1.220 governed minimum
above. `content_block_delta` `thinking_delta`/`text_delta` frames are
normalized to `reasoning.delta`/`text.delta`; the later complete assistant
message remains accepted for compatibility but is de-duplicated against those
frames. Codex and OpenCode complete item/part frames are likewise de-duplicated
when they repeat an official reasoning delta.

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
