# DSH JSON-RPC Agent CLI Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the incomplete DSH headless adapter with the official rc.6 unattended JSON-RPC runtime, then complete governed provider, Session, Web, image, schema, and documentation support without any TUI code.

**Architecture:** `dsh-jsonrpc-agent` runs as the existing Agentbox-owned JSONL subprocess against a complete Job-local Cordis composition. A deterministic Session ID is used for initialize, every prompt/follow-up, archive capture, and bounded recovery; durable notifications are normalized into the existing runtime stream, and model traffic remains behind the Job Gateway.

**Tech Stack:** TypeScript ESM, Node `tsx --test`, LF-JSONL JSON-RPC 2.0, official `@deepseek-ai/dsh-*` rc.6 packages, Fastify/PostgreSQL baseline schema, React 19, Docker/OCI manifests.

## Global Constraints

- Pin every installed `@deepseek-ai/dsh-*` runtime package to exactly `0.1.0-rc.6`; do not use `latest`, `next`, `^`, or `~` in governed manifests/install commands.
- Use `agent_cli: "dsh"` and the official packaged JSON-RPC entrypoint; remove production use of `dsh --profile headless`.
- Set `DSH_HOME=/workspace/.deepsonar-home/.dsh`, `DSH_CORDIS_CONFIG=/workspace/.deepsonar-home/.dsh/deepsonar.cordis.yml`, `DSH_SESSION_ROOT=/workspace/.deepsonar-home/.dsh/sessions`, `DSH_CWD=/workspace`, `DSH_TELEMETRY_DISABLED=1`, and `DSH_PERMISSION_MODE=danger-full-access` inside the existing Agentbox sandbox.
- Use only official wire methods `initialize`, `session/prompt`, and `shutdown`; do not invent cancel, steer, or resume methods.
- Reuse one deterministic governed Session ID for all messages and process recovery; never create a replacement Session as retry fallback.
- Declare `controlMcp: false`, `platformControlApi: true`, `incrementalMessages: true`, `interactiveTerminal: false`; do not inject `deepsonar-control` into DSH MCP.
- Route model traffic through `DEEPSEEK_BASE_URL=<Job Gateway /gateway URL>` and `DEEPSEEK_API_KEY=<short-lived Job token>`; no long-lived secret may enter snapshots, workspace files, Sessions, or evidence.
- The Cordis composition must contain no TUI/Web/browser/theme/ANSI/keyboard/console-logger/ask-user/direct-web-search rows or third-party TUI dependency.
- Preserve DSH-owned automatic compaction, tool-result pruning, Session checkpoints, and uncompressed JSONL persistence.
- Exact Session archive capture is capped at 32 MiB and fails closed on path escape, symlink, compression, ambiguity, malformed header, or ID mismatch.
- Database changes modify only `database/schema.sql`, bump `SCHEMA_VERSION` from 29 to 30, and add no migration or fallback.
- Preserve Claude Code, Codex, OpenCode, and Pi behavior; use the existing Executor and Agentbox path.
- Follow TDD for every production behavior: write and run a focused failing test, implement the minimum, then rerun the focused suite.

---

### Task 1: Official JSON-RPC runtime lifecycle

**Files:**
- Modify: `packages/runtime-sandbox/src/runtime-adapters.ts`
- Modify: `packages/runtime-sandbox/src/runtime-adapters.test.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.test.ts`

**Produces:** DSH JSON-RPC framing/state, deterministic Session identity, normalized durable events, idle settlement, shutdown, and same-ID recovery.

- [ ] Add RED tests asserting `outputMode: "jsonl"`, the exact `dsh-jsonrpc-agent` command/env, initialize followed by `session/prompt`, repeat prompts on one Session ID, response error handling, Session mismatch rejection, assistant/final/tool projection, idle settlement, shutdown, and recovery with the same ID.
- [ ] Run `pnpm --filter @deepsonar/scheduler exec tsx --test ../../packages/runtime-sandbox/src/runtime-adapters.test.ts ../../packages/runtime-sandbox/src/agentbox.test.ts`; verify failures identify the old headless/plain-final behavior.
- [ ] Remove the DSH plain-final/headless path. Add bounded JSON-RPC request correlation and a DSH adapter state that does not treat responses as runtime events. Map `session.event`/`session.status` into the existing normalized stream and make terminal idle close only after completion-gate success and protocol shutdown.
- [ ] Rerun the focused tests and runtime-sandbox typecheck; all must pass.
- [ ] Commit only the four scoped files with `feat(runtime): drive DSH over official JSON-RPC`.

### Task 2: Minimal governed Cordis composition

**Files:**
- Modify: `packages/runtime-sandbox/src/runtime-adapters.ts`
- Modify: `packages/runtime-sandbox/src/runtime-adapters.test.ts`

**Produces:** `/workspace/.deepsonar-home/.dsh/deepsonar.cordis.yml` and DSH Job environment.

- [ ] Add RED tests for the required SDK/agent/LLM/session/instruction/tool/compaction rows and explicit absence of TUI, Web, UI client, console logger, ask-user, direct search, telemetry, and `deepsonar-control` MCP rows.
- [ ] Run the adapter test and verify the current patch-array materialization fails.
- [ ] Materialize one complete YAML document with safe JSON scalars, frozen model/system prompt/workspace/session values, only validated non-control MCP rows, uncompressed persistence, automatic compaction, and tool-result pruning. Do not load profile or home patch layers.
- [ ] Rerun focused tests and typecheck; commit as `feat(runtime): materialize minimal DSH machine profile`.

### Task 3: DeepSeek provider and Gateway dialect

**Files:**
- Modify: `apps/scheduler/src/provider-settings.ts`
- Modify: `apps/scheduler/src/provider-settings.test.ts`
- Modify: `apps/scheduler/src/provider-effective-model.ts`
- Modify: `apps/scheduler/src/provider-effective-model.test.ts`
- Modify: `apps/scheduler/src/credentials.ts`
- Modify: `apps/scheduler/src/credential-compatibility.test.ts`
- Modify: `apps/scheduler/src/executor-real.ts`
- Modify: `apps/scheduler/src/executor-real.test.ts`
- Modify: `database/schema.sql`
- Modify: `apps/scheduler/src/schema-version.ts`
- Modify: `agent-harness/test-transfer-schema-version.ts`

**Produces:** `ProviderAgentCli` including DSH, DeepSeek catalog/settings, Gateway env rewrite, schema v30.

- [ ] Keep the existing provider-settings RED tests and add RED coverage for compatibility, effective model/base URL, secret scrubbing, Gateway token/base URL, and schema 30.
- [ ] Run the focused Scheduler tests and verify DSH is rejected before implementation.
- [ ] Implement the minimum DeepSeek-native dialect. Materialized settings/config may reference `DEEPSEEK_API_KEY` but never contain its value. Update the baseline check and version only.
- [ ] Run focused tests plus `pnpm ci:test:transfer-schema`; commit as `feat(scheduler): route DSH through Model Gateway`.

### Task 4: Exact DSH Session archive and Web parser

**Files:**
- Modify: `packages/runtime-sandbox/src/cli-session-adapters.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.test.ts`
- Modify: `apps/web/src/session-viewer/parseAgentSession.ts`
- Modify: `apps/web/src/session-viewer/parseAgentSession.test.ts`

**Produces:** exact-ID DSH `SessionBundle`, `DSH` viewer timeline, usage projection.

- [ ] Add literal rc.6 JSONL fixture tests for exact Session ID, user/assistant/reasoning/tool/usage events, malformed header, mismatched ID, symlink/path escape, compression, ambiguity, and 32 MiB cap.
- [ ] Run runtime/Web Session tests and verify DSH export/parser failures.
- [ ] Implement exact-ID resolution under the Job root and bounded capture; never scan host home or choose `latest`. Parse known events and preserve unknown rows only in raw download.
- [ ] Rerun both suites and commit as `feat(session): archive and render DSH sessions`.

### Task 5: Web and marketplace DSH surface

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/CredentialConfigEditor.tsx`
- Modify: `apps/web/src/ProviderAccountFlow.tsx`
- Modify: `apps/web/src/agent-marketplace.ts`
- Modify: `apps/web/src/agent-marketplace.test.ts`
- Create: `apps/web/src/provider-account-dsh.test.ts`

- [ ] Add RED tests for DSH agent-pack acceptance, selector label, and DeepSeek protocol label/settings fields.
- [ ] Extend existing unions/editor branches without adding a second provider-management screen or DSH TUI.
- [ ] Run focused tests and Web typecheck; commit as `feat(web): expose DSH provider configuration`.

### Task 6: Pinned official machine-runtime images

**Files:**
- Modify: `agent-harness/runtime-images.json`
- Modify: `agent-harness/kali-minimal-runtime.json`
- Modify: `agent-harness/check-runtime-image-consistency.mjs`
- Modify: `agent-harness/test-runtime-image.mjs`
- Modify: `deploy/Dockerfile.agent`
- Modify: `deploy/Dockerfile.agent-kali-minimal`

- [ ] Add RED consistency assertions for exact rc.6 packages/integrities, `dsh-jsonrpc-agent`, and absence of `dsh-cc-tui`.
- [ ] Install the official SDK JSON-RPC bin/server/protocol plus the exact plugin closure referenced by `deepsonar.cordis.yml`; verify every spec before install.
- [ ] Run image consistency and a local `dsh-jsonrpc-agent` protocol boot with no Provider call; commit as `build(images): install pinned DSH machine runtime`.

### Task 7: Documentation, deterministic two-turn smoke, and full verification

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/AGENT_CLI_RUNTIME_ADAPTERS.md`
- Create: `agent-harness/test-dsh-jsonrpc.mjs`
- Modify: `package.json`

- [ ] Add a RED smoke that boots a loopback mock Chat Completions/Gateway, sends two prompts to one Session, observes two idle intervals, shuts down, and captures one Session without any real key.
- [ ] Document official JSON-RPC multi-turn behavior, no UI/TUI dependency, HTTP-only platform control, same-ID recovery limits, schema v30, and image closure.
- [ ] Run `pnpm ci:unit:runtime-sandbox`, focused provider/executor/credential/Web tests, `pnpm ci:test:transfer-schema`, `pnpm ci:images`, the new smoke, `pnpm typecheck`, `pnpm build`, and `git diff --check`.
- [ ] Commit as `docs: document and verify DSH JSON-RPC compatibility`.
