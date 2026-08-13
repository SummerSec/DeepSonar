# DSH Agent CLI Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@deepseek-ai/dsh@0.1.0-rc.6` as a governed fifth Agent CLI with Gateway-only model credentials, HTTP-only platform control, bounded raw Session capture, Web rendering, and official-image availability.

**Architecture:** Extend the existing adapter, credential, evidence, viewer, and image registries instead of creating a DSH-specific Executor. DSH runs once with `--profile headless`, its bounded stdout becomes the final text, its internally generated Session is discovered only inside the Job-owned `DSH_HOME`, and all semantic platform effects use the existing Job-scoped HTTP API because headless does not expose structured MCP events.

**Tech Stack:** TypeScript ESM, Node test runner through `tsx --test`, Fastify/PostgreSQL baseline schema, React 19, Agentbox, Docker/OCI image manifests, DSH YAML-compatible JSON patches.

## Global Constraints

- Pin exactly `@deepseek-ai/dsh@0.1.0-rc.6` with integrity `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==`; never accept a range or mutable tag.
- Use `agent_cli: "dsh"`, executable `dsh`, and one-shot command `dsh --profile headless --patch /workspace/.deepsonar-home/.dsh/deepsonar.patch.json <task>`.
- Set `DSH_HOME=/workspace/.deepsonar-home/.dsh` and `DSH_TELEMETRY_DISABLED=1` for every DSH Job.
- Declare `controlMcp: false` and `platformControlApi: true`; never inject `deepsonar-control` into DSH MCP configuration and never parse stdout prose as a semantic event.
- Route model traffic through `DEEPSEEK_BASE_URL=<Job Gateway /gateway URL>` and `DEEPSEEK_API_KEY=<short-lived Job token>`; long-lived credentials must not enter snapshots, workspace files, Sessions, or evidence.
- Disable DSH's direct web-search rows in the governed patch; preserve DSH-owned automatic compaction and tool-result pruning.
- Headless `0.1.0-rc.6` has no supported resume. Never start a new Session as an implicit retry.
- Discover Sessions only under the fixed Job-owned DSH home, require exactly one uncompressed `session.jsonl`, validate its header ID, and cap aggregate capture at 32 MiB.
- Database changes modify only `database/schema.sql`, bump `SCHEMA_VERSION` from 29 to 30, and add no migration or fallback.
- Preserve existing Claude Code, Codex, OpenCode, and Pi behavior; do not add a parallel Executor or a new runtime dependency.
- Follow test-driven development for each production behavior: add a focused failing test, run it and record the expected failure, implement the minimum, then rerun the focused suite.

---

## File structure

- `packages/runtime-sandbox/src/runtime-adapters.ts`: DSH lifecycle, fixed invocation, patch materialization, plain-final output declaration, and capabilities.
- `packages/runtime-sandbox/src/agentbox.ts`: generic bounded plain-final stdout handling and post-run Session identity observation.
- `packages/runtime-sandbox/src/cli-session-adapters.ts`: governed DSH Session discovery and export.
- `apps/scheduler/src/provider-settings.ts`, `provider-effective-model.ts`, `credentials.ts`, `executor-real.ts`: DeepSeek-native settings, compatibility, scrubbing, and Gateway environment rewrite.
- `apps/web/src/session-viewer/parseAgentSession.ts`: DSH JSONL projection into the existing timeline model.
- `apps/web/src/api.ts`, `CredentialConfigEditor.tsx`, `ProviderAccountFlow.tsx`, `agent-marketplace.ts`: fifth-CLI UI/types.
- `agent-harness/*.json`, `deploy/Dockerfile*`, and image consistency scripts: pinned CLI installation and catalog evidence.
- `database/schema.sql`, `apps/scheduler/src/schema-version.ts`: schema v30 baseline.
- `DESIGN.md`, `docs/AGENT_CLI_RUNTIME_ADAPTERS.md`: as-built contract.

### Task 1: Runtime lifecycle and bounded plain-final output

**Files:**
- Modify: `packages/runtime-sandbox/src/runtime-adapters.ts`
- Modify: `packages/runtime-sandbox/src/runtime-adapters.test.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.test.ts`

**Interfaces:**
- Produces: `AgentCliId` including `"dsh"`; `RuntimeAdapter.outputMode: "jsonl" | "plain-final"`; `AGENT_CLI_RUNTIME_ADAPTERS.dsh`.
- DSH capabilities: stream lifecycle/final result, HTTP platform control, Session capture, automatic compaction, no control MCP, no incremental messages, no reasoning-effort flag, no terminal.

- [ ] **Step 1: Write failing adapter and runner tests**

```ts
assert.deepEqual(Object.keys(AGENT_CLI_RUNTIME_ADAPTERS).sort(),
  ["claude-code", "codex", "dsh", "open-code", "pi"]);
assert.equal(dsh.outputMode, "plain-final");
assert.equal(dsh.capabilities.controlMcp, false);
assert.equal(dsh.capabilities.platformControlApi, true);
assert.match(started.command, /^dsh --profile headless --patch \/workspace\/\.deepsonar-home\/\.dsh\/deepsonar\.patch\.json /u);
assert.throws(() => dsh.resume(resumeContext), /DSH_HEADLESS_RESUME_UNSUPPORTED/u);
assert.equal(result.text, "final answer from dsh");
assert.equal(observedSemanticEvents.length, 0);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @deepsonar/scheduler exec tsx --test ../../packages/runtime-sandbox/src/runtime-adapters.test.ts ../../packages/runtime-sandbox/src/agentbox.test.ts`

Expected: failures name the missing `dsh` registry member/output mode and show plain stdout is not returned as final text.

- [ ] **Step 3: Implement the minimal generic protocol extension and DSH adapter**

```ts
export type AgentCliOutputMode = "jsonl" | "plain-final";
export interface RuntimeAdapter {
  readonly outputMode: AgentCliOutputMode;
  // existing members remain unchanged
}
```

Give existing adapters `outputMode: "jsonl"`. Add DSH version `0.1.0-rc.6`, fixed compatible image keys `deepsonar-base`, `deepsonar-audit`, and `deepsonar-kali-minimal`, safe shell quoting of the task, `encodeInput: () => ""`, and an explicit unsupported `resume`. In `agentbox.ts`, collect at most 1 MiB UTF-8 stdout for `plain-final`, fail with `AGENT_CLI_PLAIN_OUTPUT_TOO_LARGE` on overflow, preserve stderr diagnostics, and synthesize only normalized final text/result lifecycle data after a successful exit.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all runtime adapter and Agentbox tests pass without new warnings.

- [ ] **Step 5: Commit the task**

```powershell
git add -- packages/runtime-sandbox/src/runtime-adapters.ts packages/runtime-sandbox/src/runtime-adapters.test.ts packages/runtime-sandbox/src/agentbox.ts packages/runtime-sandbox/src/agentbox.test.ts
git commit -m "feat(runtime): add DSH headless adapter"
```

### Task 2: Governed DSH patch, MCP filtering, and static Skill placement

**Files:**
- Modify: `packages/runtime-sandbox/src/runtime-adapters.ts`
- Modify: `packages/runtime-sandbox/src/runtime-adapters.test.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.test.ts`

**Interfaces:**
- Consumes: `AGENT_CLI_RUNTIME_ADAPTERS.dsh` from Task 1.
- Produces: `/workspace/.deepsonar-home/.dsh/deepsonar.patch.json`; DSH skill destination `/workspace/.deepsonar-home/.dsh/skills`; non-control MCP patch rows.

- [ ] **Step 1: Write failing materialization tests**

```ts
assert.equal(env.DSH_HOME, "/workspace/.deepsonar-home/.dsh");
assert.equal(env.DSH_TELEMETRY_DISABLED, "1");
assert.equal(skillPath, "/workspace/.deepsonar-home/.dsh/skills/deepsonar-control/SKILL.md");
assert.equal(patch.some((row) => row.id === "deepsonar-control"), false);
assert.equal(patch.some((row) => row.name === "@deepseek-ai/dsh-mcp-client" && row.config.serverName === "repo-tools"), true);
assert.equal(patch.find((row) => row.id === "tool-web")?.disabled, true);
assert.deepEqual(patch.find((row) => row.id === "session-persistence-jsonl")?.config,
  { root: "/workspace/.deepsonar-home/.dsh/sessions", compression: "none", packChunks: false });
```

- [ ] **Step 2: Run focused tests and verify RED**

Run the Task 1 focused command. Expected: DSH patch and skill-path assertions fail because materialization is absent.

- [ ] **Step 3: Materialize a JSON document accepted as YAML**

Build an array of DSH patch rows using JSON serialization, not a YAML dependency. Include frozen model selection, uncompressed unpacked Session persistence, hard-disabled telemetry/web search, and non-interactive permissions appropriate to the outer Agentbox sandbox. Translate only validated non-control stdio/Streamable HTTP MCP records; omit a record named `deepsonar-control` and reject invalid server names or transports before DSH starts.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 focused command. Expected: both test files pass.

- [ ] **Step 5: Commit the task**

```powershell
git add -- packages/runtime-sandbox/src/runtime-adapters.ts packages/runtime-sandbox/src/runtime-adapters.test.ts packages/runtime-sandbox/src/agentbox.ts packages/runtime-sandbox/src/agentbox.test.ts
git commit -m "feat(runtime): govern DSH job configuration"
```

### Task 3: DeepSeek credential dialect and Gateway rewrite

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

**Interfaces:**
- Produces: `ProviderAgentCli` including `"dsh"`; DeepSeek provider catalog row; DSH settings at `.dsh/settings.yaml`; schema v30.
- Frozen safe settings retain `baseURL`, model IDs, context/output metadata, and `apiKeyEnv: "DEEPSEEK_API_KEY"`, but never the credential value.

- [ ] **Step 1: Write failing provider, executor, credential, and schema tests**

```ts
assert.equal(validateCredentialCompatibility("dsh", "deepseek"), null);
assert.match(validateCredentialCompatibility("dsh", "openai") ?? "", /仅兼容 deepseek/u);
assert.equal(extractEffectiveModel("dsh", settings), "deepseek-v4-flash");
assert.equal(materialized.path, ".dsh/settings.yaml");
assert.equal(materialized.content.includes("long-lived-key"), false);
assert.equal(jobEnv.DEEPSEEK_API_KEY, "job-gateway-token");
assert.equal(jobEnv.DEEPSEEK_BASE_URL, "http://gateway.internal/api/gateway");
assert.equal(SCHEMA_VERSION, 30);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @deepsonar/scheduler exec tsx --test src/provider-settings.test.ts src/provider-effective-model.test.ts src/credential-compatibility.test.ts src/executor-real.test.ts`

Expected: DSH is rejected as an unknown CLI/provider dialect and schema remains 29.

- [ ] **Step 3: Implement the DeepSeek-native dialect and schema baseline**

Add provider `deepseek` with API-key auth, base URL support, and only `dsh` compatibility. Materialize `.dsh/settings.yaml` as JSON-compatible YAML with an `llm-deepseek` namespace, `apiKeyEnv: "DEEPSEEK_API_KEY"`, safe model metadata, and no secret. Extend model/base URL extraction and Executor Gateway env rewriting. Add `dsh` to `credentials_agent_cli_check`, bump both schema version locations to 30, and keep the single-baseline/no-migration discipline.

- [ ] **Step 4: Run provider and schema tests and verify GREEN**

Run the Step 2 command, then `pnpm ci:test:transfer-schema`. Expected: all pass and report schema v30.

- [ ] **Step 5: Commit the task**

```powershell
git add -- apps/scheduler/src/provider-settings.ts apps/scheduler/src/provider-settings.test.ts apps/scheduler/src/provider-effective-model.ts apps/scheduler/src/provider-effective-model.test.ts apps/scheduler/src/credentials.ts apps/scheduler/src/credential-compatibility.test.ts apps/scheduler/src/executor-real.ts apps/scheduler/src/executor-real.test.ts database/schema.sql apps/scheduler/src/schema-version.ts agent-harness/test-transfer-schema-version.ts
git commit -m "feat(scheduler): route DSH through Model Gateway"
```

### Task 4: DSH Session discovery, evidence, and Web timeline

**Files:**
- Modify: `packages/runtime-sandbox/src/cli-session-adapters.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.ts`
- Modify: `packages/runtime-sandbox/src/agentbox.test.ts`
- Modify: `apps/web/src/session-viewer/parseAgentSession.ts`
- Modify: `apps/web/src/session-viewer/parseAgentSession.test.ts`

**Interfaces:**
- Changes: `AgentCliSessionAdapter.exportSession(runtime, sessionId?: string, sessionFile?: string)`.
- Produces: DSH `SessionBundle` whose validated header supplies `sessionId`; viewer label `DSH` and parsed user/assistant/reasoning/tool/usage rows.

- [ ] **Step 1: Add literal JSONL fixtures and failing tests**

```ts
const header = { type: "session", version: 1, id: "session-123", createdAt: "2026-08-13T00:00:00.000Z", delegationDepth: 0 };
assert.equal(bundle.sessionId, "session-123");
assert.equal(bundle.artifacts[0]?.sourcePath.startsWith("/workspace/.deepsonar-home/.dsh/sessions/"), true);
await assert.rejects(() => capture(twoSessionRuntime), /DSH_SESSION_AMBIGUOUS/u);
await assert.rejects(() => capture(compressedRuntime), /DSH_SESSION_FORMAT_UNSUPPORTED/u);
assert.deepEqual(timeline.items.map((item) => item.kind), ["user", "reasoning", "tool_call", "tool_result", "assistant"]);
assert.equal(timeline.usage.input_tokens, 42);
```

- [ ] **Step 2: Run Session tests and verify RED**

Run: `pnpm --filter @deepsonar/scheduler exec tsx --test ../../packages/runtime-sandbox/src/agentbox.test.ts && pnpm --filter @deepsonar/web exec tsx --test src/session-viewer/parseAgentSession.test.ts`

Expected: DSH export and format detection are missing.

- [ ] **Step 3: Implement fail-closed discovery and parsing**

Search only `/workspace/.deepsonar-home/.dsh/sessions` for exact `session.jsonl` files, reject zero/multiple paths and symlink/path escapes, read the first nonempty JSON row as the immutable header, require an ID matching `^session-[0-9A-Za-z-]+$`, and reuse the 32 MiB cap. Capture after process exit even when stdout emitted no identity, then notify the existing Session identity callback from the validated bundle. Parse supported DSH durable message/tool/usage event rows while preserving unknown rows only in raw download.

- [ ] **Step 4: Run Session tests and verify GREEN**

Run the Step 2 command. Expected: both suites pass, including ambiguity, malformed header, path-boundary, unsupported compression, and size-cap cases.

- [ ] **Step 5: Commit the task**

```powershell
git add -- packages/runtime-sandbox/src/cli-session-adapters.ts packages/runtime-sandbox/src/agentbox.ts packages/runtime-sandbox/src/agentbox.test.ts apps/web/src/session-viewer/parseAgentSession.ts apps/web/src/session-viewer/parseAgentSession.test.ts
git commit -m "feat(session): archive and render DSH sessions"
```

### Task 5: Web and marketplace fifth-CLI surface

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/CredentialConfigEditor.tsx`
- Modify: `apps/web/src/ProviderAccountFlow.tsx`
- Modify: `apps/web/src/agent-marketplace.ts`
- Modify: `apps/web/src/agent-marketplace.test.ts`
- Create: `apps/web/src/provider-account-dsh.test.ts`

**Interfaces:**
- Consumes: Scheduler provider catalog and `agent_cli: "dsh"` from Task 3.
- Produces: typed DSH choice, DeepSeek settings editor, and marketplace import acceptance.

- [ ] **Step 1: Write failing Web tests**

```ts
assert.doesNotThrow(() => validateAgentPack({
  config: { agent_cli: "dsh", env_vars: {}, credentials: [], config_files: [] },
}));
assert.equal(agentCliOptions.some((option) => option.value === "dsh" && option.label === "DSH"), true);
assert.equal(providerProtocolLabel("deepseek", "dsh", catalog), "DeepSeek Chat Completions");
```

- [ ] **Step 2: Run focused Web tests and verify RED**

Run: `pnpm --filter @deepsonar/web exec tsx --test src/agent-marketplace.test.ts src/provider-account-dsh.test.ts`

Expected: the marketplace assertion rejects DSH and the provider-account test cannot import DSH choice/label helpers until they are exported from the existing components.

- [ ] **Step 3: Extend the existing unions and editor branches**

Add `"dsh"` to every Web `AgentCli`/API union and selector. Render DSH settings using the DeepSeek catalog fields `baseURL`, `models[].id`, optional context/output metadata, and saved-key sentinel behavior already used by other provider editors. Do not add a second provider-management screen.

- [ ] **Step 4: Run focused Web tests and typecheck**

Run the available Step 2 tests, then `pnpm --filter @deepsonar/web typecheck`. Expected: all pass.

- [ ] **Step 5: Commit the task**

```powershell
git add -- apps/web/src/api.ts apps/web/src/CredentialConfigEditor.tsx apps/web/src/ProviderAccountFlow.tsx apps/web/src/agent-marketplace.ts apps/web/src/agent-marketplace.test.ts apps/web/src/provider-account-dsh.test.ts
git commit -m "feat(web): expose DSH provider configuration"
```

### Task 6: Official runtime images and pinned supply-chain evidence

**Files:**
- Modify: `agent-harness/runtime-images.json`
- Modify: `agent-harness/kali-minimal-runtime.json`
- Modify: `agent-harness/check-runtime-image-consistency.mjs`
- Modify: `agent-harness/test-runtime-image.mjs`
- Modify: `deploy/Dockerfile.agent`
- Modify: `deploy/Dockerfile.agent-kali-minimal`

**Interfaces:**
- Produces: official tool-manifest record for `@deepseek-ai/dsh`, CLI identity `dsh`, exact RC6 version/integrity, and compatible image keys.

- [ ] **Step 1: Add failing image consistency assertions**

```js
expect(config.npm["@deepseek-ai/dsh"].version === "0.1.0-rc.6", "DSH version drifted");
expect(config.npm["@deepseek-ai/dsh"].integrity === "sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==", "DSH integrity drifted");
expect(config.npm["@deepseek-ai/dsh"].agent_cli === "dsh", "DSH CLI identity drifted");
```

- [ ] **Step 2: Run image consistency and verify RED**

Run: `node agent-harness/check-runtime-image-consistency.mjs`

Expected: missing DSH manifest/install assertions fail.

- [ ] **Step 3: Add the pinned package to manifests and install paths**

Use capabilities `agent-runtime`, `headless`, `platform-control-api`, and `session-capture`. Add DSH wherever official images install all supported CLIs, verify npm integrity before global install using the existing Pi supply-chain pattern, and keep image budgets unchanged until a measured compressed build exceeds one.

- [ ] **Step 4: Run consistency and local package smoke**

Run: `node agent-harness/check-runtime-image-consistency.mjs`

Refresh PATH in the current PowerShell process from machine/user values, then run `dsh --version` and verify exact output `0.1.0-rc.6`. No Provider key is used.

- [ ] **Step 5: Commit the task**

```powershell
git add -- agent-harness/runtime-images.json agent-harness/kali-minimal-runtime.json agent-harness/check-runtime-image-consistency.mjs agent-harness/test-runtime-image.mjs deploy
git commit -m "build(images): install pinned DSH runtime"
```

### Task 7: As-built documentation, mock smoke, and full verification

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/AGENT_CLI_RUNTIME_ADAPTERS.md`
- Create: `agent-harness/test-dsh-headless.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm ci:smoke:dsh-headless`; documented fifth-CLI matrix and HTTP-only semantic-control limitation.

- [ ] **Step 1: Add the failing deterministic smoke**

The script starts loopback mock `/chat/completions` and Job-control endpoints, creates a temporary isolated `DSH_HOME`, invokes the locally installed exact DSH command with the governed patch, verifies bearer authentication and requested model, checks one uncompressed Session header, passes it through the Session parser/export path, and always removes the temporary directory and closes servers. Assert that no real Provider URL or credential is used.

- [ ] **Step 2: Run the smoke and verify RED**

Run: `node agent-harness/test-dsh-headless.mjs`

Expected: fail because the new smoke's adapter/parser integration or package script is not complete; environment absence may be reported only as `DSH_SMOKE_BINARY_MISSING`, not silently skipped.

- [ ] **Step 3: Complete the smoke and as-built docs**

Document the pinned RC, plain-final output, HTTP-only platform control, no resume, governed Session discovery, DeepSeek Gateway mapping, schema v30, and image installation. Add `"ci:smoke:dsh-headless": "node agent-harness/test-dsh-headless.mjs"` to root scripts.

- [ ] **Step 4: Run fresh verification**

```powershell
pnpm ci:unit:runtime-sandbox
pnpm ci:unit:provider-settings
pnpm ci:unit:executor-real
pnpm ci:unit:credential-compatibility
pnpm --filter @deepsonar/web exec tsx --test src/session-viewer/parseAgentSession.test.ts src/agent-marketplace.test.ts
pnpm ci:test:transfer-schema
pnpm ci:images
pnpm ci:smoke:dsh-headless
pnpm typecheck
pnpm build
git diff --check
```

Expected: every command exits 0; the smoke reports DSH `0.1.0-rc.6`, Gateway-shaped auth, and one parsed Session.

- [ ] **Step 5: Commit the task**

```powershell
git add -- DESIGN.md docs/AGENT_CLI_RUNTIME_ADAPTERS.md agent-harness/test-dsh-headless.mjs package.json
git commit -m "docs: document and verify DSH compatibility"
```
