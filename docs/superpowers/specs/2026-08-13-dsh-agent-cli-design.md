# DSH Agent CLI Compatibility Design

## Goal

Add DeepSeek Harness as the fifth governed DeepSonar Agent CLI, identified by
`agent_cli: "dsh"`, without embedding a terminal UI. The integration must keep
one durable DSH Session alive for initial input, live canvas/human follow-ups,
completion-gate corrections, and bounded same-session recovery while preserving
DeepSonar's Scheduler-owned authority and Job sandbox.

The supported upstream release is exactly `0.1.0-rc.6`. All DSH packages used
by the image are pinned to that version and their npm integrity is verified.

## Confirmed upstream contract

The official rc.6 release contains an unattended process interface separate
from the `dsh` TUI/Web surfaces:

- `@deepseek-ai/dsh-sdk-jsonrpc-demo` provides `dsh-jsonrpc-agent`.
- `@deepseek-ai/dsh-sdk-jsonrpc-server` serves LF-delimited JSON-RPC 2.0 over
  stdio. Stdout is protocol-only and diagnostics are written to stderr.
- Requests are `initialize`, `session/prompt`, and `shutdown`.
- Notifications are `session.event`, `session.status`, `subagent.started`, and
  `subagent.finished`.
- `session/prompt` invokes `Agent.followup` on a stable caller-supplied
  `sessionId`; repeated prompts therefore continue the same live Session.
- `session.event` carries the complete durable Session event envelope. A turn
  is owned from its `agent/inbox/spliced` receipt through the next root
  `session.status: idle` notification.
- The protocol has no per-turn cancel or steer method. Job cancellation closes
  the runtime process. Messages arriving during a turn use another
  `session/prompt`, which DSH queues through the same Agent inbox.
- The runtime is configured by an external `cordis.yml`; it has no default
  configuration and must not load a stdout logger.

The existing `dsh --profile headless` implementation is superseded. Headless
is one fresh Session and cannot meet the approved multi-turn contract.

## Architecture

### Runtime adapter and JSON-RPC lifecycle

Keep the existing `RuntimeAdapter`/Agentbox execution path. DSH starts
`dsh-jsonrpc-agent /workspace/.deepsonar-home/.dsh/deepsonar.cordis.yml` and
uses the adapter's existing JSONL framing.

DeepSonar generates a stable Job-scoped Session ID before launch. The adapter
sends two frames before the first user prompt:

1. `initialize` with `/workspace`, provider `deepseek-official`, the frozen
   model, and an optional frozen output-token cap;
2. `session/prompt` with the stable Session ID and one text content block.

Every later `sendMessage` and completion-gate nudge sends another
`session/prompt` for the same Session ID. JSON-RPC request IDs are local
correlation values and are never treated as Session or semantic-event IDs.

The adapter validates the initialize response's server identity, validates
every root Session notification against the frozen Session ID, and projects
durable DSH events into the existing normalized stream:

- assistant text/reasoning chunks -> progress deltas;
- assistant messages -> final text;
- tool-call/tool-result content -> normalized tool telemetry;
- `turn/end` reason -> provider success/failure;
- root `session.status: idle` -> one settled interval.

The settled interval does not automatically end the process. If the completion
gate is open, Agentbox sends another prompt. Once the gate passes, Agentbox
sends `shutdown`, waits for its response, then closes stdin. Transport loss,
malformed JSON-RPC, mismatched Session IDs, or idle without a durable receipt
fails closed.

Across a bounded runner retry, the adapter starts a new JSON-RPC process with
the same governed `sessionId` and persisted Session root, initializes it, then
sends the recovery prompt. It never mints a replacement Session. This resumes
durable conversation state; process-owned shell state is not promised across a
process failure.

### Governed Cordis composition

DeepSonar materializes one complete `deepsonar.cordis.yml`; it does not load
DSH profiles, user patches, project `.dsh` plugins, or third-party TUI bundles.
The composition contains only:

- official SDK JSON-RPC server;
- DSH Agent/loop, DeepSeek LLM adapter, Session persistence/checkpointing;
- system prompt plus repository instruction loading;
- the minimum coding tools already allowed by the Agentbox sandbox;
- DSH automatic compaction and tool-result pruning;
- optional validated non-control MCP servers; and
- no console logger, TUI, Web server, ask-user UI, browser client, theme,
  keyboard, ANSI rendering, or direct web-search rows.

Session persistence is uncompressed JSONL at
`/workspace/.deepsonar-home/.dsh/sessions`. `DSH_TELEMETRY_DISABLED=1` is set
independently of composition. The existing static `deepsonar-control` Skill and
Job-scoped HTTP capability API remain the semantic-effect path; DSH MCP must
not receive `deepsonar-control` until its tool events are mapped to the same
host validation contract.

### Model Gateway and credentials

Credential settings use a DeepSeek-native document with `apiKey`, `baseURL`,
and model metadata. Long-lived secrets are scrubbed before Job freezing. The
runtime receives only:

- `DEEPSEEK_API_KEY=<short-lived Job Gateway token>`;
- `DEEPSEEK_BASE_URL=<fixed /gateway base URL>`;
- frozen model metadata without the secret value.

The existing Gateway maps `/gateway/chat/completions` to the configured
upstream, replaces bearer credentials, and enforces allowed model and quota.

### Session archive and viewer

The adapter already owns the exact Session ID, so archive capture never scans
for a guessed `latest` Session. The DSH Session exporter resolves only that ID
under the fixed Job-owned root, rejects path/symlink escape, compressed or
ambiguous artifacts, malformed headers, header-ID mismatch, and aggregate data
over 32 MiB.

The Web viewer projects supported DSH user/assistant/reasoning/tool/usage rows
into the existing timeline and keeps raw JSONL download for unknown rows.

### Images and schema

Official images install exact rc.6 packages required by the unattended runtime
and composition. Image verification checks the `dsh-jsonrpc-agent` executable,
package versions/integrities, and a no-provider protocol boot smoke. Installing
only the base `dsh` launcher is insufficient.

The credential `agent_cli` check adds `dsh`; the single baseline schema bumps
from 29 to 30 with no migration or compatibility fallback.

## Security and failure handling

- Long-lived provider credentials never enter snapshots, workspace files,
  evidence, Sessions, or the DSH environment.
- Stdout accepts only bounded JSON-RPC frames; prose and malformed frames are
  protocol failures, never semantic events.
- Direct DSH search, telemetry, Web/TUI, approval UI, and dynamically installed
  project plugins are absent from the composition.
- The Job-scoped HTTP control API validates every request against the frozen
  Scheduler capability snapshot.
- Job cancel/timeout terminates the owned runtime process because rc.6 exposes
  no prompt-cancel method.
- Same-session recovery validates frozen context identity and Session ID before
  sending a recovery prompt.

## Testing and acceptance

1. Adapter tests cover exact command/env, deterministic Session ID, initialize,
   prompt/follow-up/shutdown frames, response correlation, Session-ID mismatch,
   durable event projection, idle settlement, and same-ID process recovery.
2. Cordis tests assert the minimal row allowlist and the absence of all TUI,
   Web, theme, logger, approval UI, and direct-search rows.
3. Provider tests cover model/base URL extraction, secret scrubbing, and Job
   Gateway environment rewrite.
4. Session tests cover exact-ID export and malformed/oversized/path-escape
   rejection; Web tests cover DSH message/reasoning/tool/usage projection.
5. Image checks cover every exact rc.6 package and `dsh-jsonrpc-agent` boot.
6. A deterministic mock Chat Completions smoke runs two prompts on one Session,
   verifies Gateway-shaped authentication, receives two idle intervals, performs
   protocol shutdown, and captures one uncompressed Session without a real key.
7. Focused tests, `pnpm typecheck`, `pnpm build`, schema consistency, image
   consistency, and `git diff --check` all pass.

## Out of scope

- Any DSH Web/TUI embedding, terminal skin, theme, React/Ink, ANSI renderer,
  keyboard mapping, or PTY automation.
- Third-party `dsh-cc-tui` runtime code or dependency.
- Dynamic DSH plugin installation from RoleConfig or project content.
- Inventing per-turn cancel/steer methods absent from the official rc.6 wire.
- Replacing DeepSonar's Scheduler authority, MCP, or Job-scoped control API.
