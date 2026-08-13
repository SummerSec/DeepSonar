# DSH Agent CLI Compatibility Design

## Goal

Add `@deepseek-ai/dsh` as the fifth governed DeepSonar Agent CLI, identified by
`agent_cli: "dsh"`, with the same end-to-end guarantees as the existing Claude
Code, Codex, OpenCode, and Pi adapters: frozen runtime configuration, Job-scoped
Gateway credentials, Scheduler-owned control effects, bounded Session capture,
and a structured Web Session viewer.

The first supported upstream release is exactly `@deepseek-ai/dsh@0.1.0-rc.6`.
It is an RC published on 2026-08-13, so the runtime image verifies the npm
integrity and protocol tests pin the observed behavior rather than accepting a
moving range.

## Confirmed upstream contract

- Executable: `dsh`.
- One-shot invocation: `dsh --profile headless "<task>"`.
- The headless profile creates one fresh persisted Session, prints the final
  assistant text to stdout, and exits `0` only for a completed turn.
- Provider configuration accepts `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and a
  model selection in `$DSH_HOME/settings.yaml` under `llm-deepseek` plus the
  `agent-default-model` patch row.
- Native DeepSeek traffic is streaming `POST {baseURL}/chat/completions` with
  `Authorization: Bearer <key>`.
- DSH supports stdio and Streamable HTTP MCP; stdio tools are model-facing as
  `mcp__<serverName>__<rawName>`.
- Workspace instructions load from `AGENTS.md` and `CLAUDE.md`.
- Sessions persist below `$DSH_HOME/sessions` as JSONL, Zstandard-compressed by
  default. DeepSonar selects uncompressed JSONL for bounded host-side capture.
- DSH owns automatic compaction and tool-result pruning.
- The headless profile has no interactive follow-up or documented resume
  command in `0.1.0-rc.6`.

## Architecture

### Runtime adapter

Extend the existing runtime adapter registry with `dsh`; do not add a parallel
Executor path. The adapter starts the fixed headless command and uses stdout as
the final-answer stream. Because stdout is not a structured event stream, the
adapter emits only normalized text/result lifecycle records. Semantic control
events therefore use the existing Job-scoped platform HTTP API, never parsing
DSH prose and never treating an unobservable MCP call as Scheduler-confirmed.

The sandbox owns a per-Job home at `/workspace/.deepsonar-home/.dsh` through
`DSH_HOME`. DeepSonar materializes a Job-specific profile patch that:

- selects the frozen RoleConfig model;
- sets Session persistence to `compression: none` under the governed DSH home;
- disables the bundled direct web-search tool and telemetry;
- permits non-control RoleConfig MCP servers through DSH's native client, while
  deliberately omitting the `deepsonar-control` MCP server in this release;
- disables DSH telemetry (`DSH_TELEMETRY_DISABLED=1`);
- retains DSH's native automatic compaction; and
- selects non-interactive tool approval inside the already isolated Agentbox
  sandbox so headless execution cannot wait for an unavailable human prompt.

DSH also receives the existing static `deepsonar-control` Skill and Job-scoped
HTTP capability token. The HTTP API validates requests against the frozen
Scheduler capability snapshot and remains the only semantic-effect path for
DSH. This restriction can be removed only if a future pinned headless protocol
exposes structured MCP tool-use/tool-result events to the host.

### Model Gateway and credentials

Credential settings for `dsh` use a small DeepSeek-native document:

```json
{
  "apiKey": "<long-lived secret before freezing>",
  "baseURL": "https://api.deepseek.com",
  "models": [{ "id": "deepseek-v4-flash" }]
}
```

At Job materialization, long-lived secret fields are scrubbed. The sandbox copy
uses only:

- `DEEPSEEK_API_KEY=<short-lived Job Gateway token>`;
- `DEEPSEEK_BASE_URL=<fixed /gateway base URL>`;
- `$DSH_HOME/settings.yaml` selecting the frozen model and preserving safe
  context/output metadata.

The current Gateway wildcard already maps `/gateway/chat/completions` to the
credential upstream's `/chat/completions` and replaces the bearer credential.
Allowed-model and quota checks remain Scheduler-owned. DSH-specific attribution
headers are forwarded but do not affect authorization.

### Session identity and archive

DSH generates a `session-<uuid>` identity internally but headless stdout does
not expose it. The runtime records the pre-run Session directory baseline and,
after exit, accepts exactly one newly created governed Session artifact. It
reads the immutable header to obtain the Session ID, rejects zero/multiple new
Sessions, path traversal, compressed or non-JSONL artifacts, malformed headers,
and a total over 32 MiB. It never scans the host home, guesses `latest`, or
crosses the Job-owned `DSH_HOME`.

The raw JSONL is stored through the existing Job evidence/session pipeline.
The Web parser recognizes DSH header and event rows, then projects user and
assistant messages, reasoning, tool calls/results, completion/error boundaries,
and token/cache usage when present. Raw download remains available.

### Resume and failure policy

`0.1.0-rc.6` headless provides no documented resume surface. The adapter
therefore declares no runtime session resume capability and never starts a new
DSH Session as an implicit retry. Provider retries and compaction remain DSH's
own durable-step policy; once the CLI exits, DeepSonar applies its normal Job
terminal semantics. A future DSH version may add explicit resume support only
after a new pinned protocol test.

### Runtime images and schema

All official Agent images install exactly `@deepseek-ai/dsh@0.1.0-rc.6` and
verify its npm integrity before installation. Runtime manifests declare
`agent_cli: "dsh"` and compatible image keys. Image-size budgets change only
when measured compressed image evidence requires it.

The `credentials.agent_cli` check adds `dsh`; because the schema is a single
baseline, bump `SCHEMA_VERSION` and require database recreation. RoleConfig's
free string field needs no migration.

## Security and failure handling

- Long-lived DeepSeek credentials never enter Job snapshots, workspace files,
  evidence, Session JSONL, or the DSH process environment.
- DSH telemetry is disabled independently of upstream defaults.
- Platform-control API discovery and requests fail closed; schema validation
  and effects still occur in the existing Scheduler control path.
- DSH's bundled web search must not bypass the Job Gateway. The governed patch
  disables model-facing `tool-web`/DeepSeek search for this adapter until it can
  use a Scheduler-owned allowlisted proxy.
- The DSH home and profile are Job-local. Project-provided `.dsh` content is not
  auto-loaded as configuration or plugins.
- Unsupported/malformed output is retained only in bounded process evidence and
  cannot become a semantic event by text parsing.

## Testing and acceptance

1. Adapter tests first fail for the absent `dsh` registry entry, then cover the
   exact command, environment, patch, capability declarations, output lifecycle,
   and explicit lack of resume.
2. Provider tests cover legacy settings, model/base URL extraction, secret
   scrubbing, Job Gateway rewrite, and materialized DSH YAML.
3. Session tests use literal DSH JSONL fixtures for single-session capture,
   ambiguous/malformed/oversized rejection, and Web timeline/usage projection.
4. Runtime image consistency tests cover version, integrity, CLI identity, and
   all compatible official images.
5. Schema/version consistency, focused package tests, full `pnpm typecheck`,
   `pnpm build`, and runtime-image consistency checks pass.
6. A local smoke using the installed `dsh 0.1.0-rc.6`, an isolated `DSH_HOME`,
   a mock `/chat/completions` endpoint, and a mock Job control HTTP API
   demonstrates one headless run, Gateway-shaped authentication, Session
   creation, and archive parsing without a real Provider key.

## Out of scope

- DSH Web/TUI embedding or exposing its browser UI.
- Dynamic DSH plugin installation from RoleConfig or project content.
- DSH-to-DSH Session resume before an upstream headless resume contract exists.
- Replacing the existing MCP or Job-scoped HTTP platform APIs.
- Enabling DSH's direct web-search provider or any direct outbound model path.
