import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderCredentialResolveError,
  resolveProviderCredentialForJob,
} from "./resolve-credential.js";
import { parseProjectAgentAllowlist } from "../project-agent-allowlist/policy.js";

const CRED_A = "11111111-1111-4111-8111-111111111111";
const CRED_B = "22222222-2222-4222-8222-222222222222";

function dbWith(rows: Array<Record<string, unknown>>, loads: Array<Record<string, unknown>> = [], rules: Record<string, unknown> = {}) {
  const query = async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("FROM global_settings")) return [{ rules_json: rules }];
    if (sql.includes("FROM credentials")) {
      return rows.filter((row) => {
        if (sql.includes("status = 'active'") && row.status !== "active") return false;
        return true;
      });
    }
    if (sql.includes("COUNT(*)::int AS count")) return loads.map(load => ({
      status: "running", project_id: "project-1", credential_provider: "anthropic", agent_cli: "claude-code",
      model: "claude-sonnet-4", count: load.active_jobs, ...load,
    }));
    if (sql.includes("FROM jobs")) return loads.filter(load => load.total_jobs !== 0)
      .map((load) => ({ assigned_jobs: load.active_jobs, ...load }));
    return [];
  };
  return Object.assign(query, { json: (value: unknown) => value });
}

function allowlist(partial: Record<string, unknown>) {
  return parseProjectAgentAllowlist({
    enabled_agent_clis: ["claude-code", "pi", "dsh"],
    enabled_credential_ids: [CRED_A, CRED_B],
    agent_allowlist_configured: true,
    ...partial,
  });
}

const baseRow = (id: string, provider = "anthropic") => ({
  id,
  name: `cred-${id.slice(0, 4)}`,
  provider,
  status: "active",
  project_id: null,
  agent_cli: "claude-code",
  settings_config_json: { env: { ANTHROPIC_MODEL: "claude-sonnet-4" } },
  public_metadata_json: {},
  meta_json: {},
  model_catalog_json: ["claude-sonnet-4"],
  model_catalog_fetched_at: null,
  health_status: "ok",
});

test("#690 resolve: unique match returns credential", async () => {
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([baseRow(CRED_A)]) as never,
    projectId: "project-1",
    agentCli: "claude-code",
    allowlist: allowlist({ enabled_credential_ids: [CRED_A], default_credential_id: CRED_A }),
    provider: "anthropic",
    modelRef: "claude-sonnet-4",
  });
  assert.equal(resolved?.id, CRED_A);
});

test("#690 resolve: no match fail-closed", async () => {
  await assert.rejects(
    () => resolveProviderCredentialForJob({
      db: dbWith([baseRow(CRED_A, "openai")]) as never,
      projectId: "project-1",
      agentCli: "claude-code",
      allowlist: allowlist({ enabled_credential_ids: [CRED_A] }),
      provider: "anthropic",
    }),
    (error: unknown) => error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_no_match",
  );
});

test("#1002 resolve: an explicitly authorized homogeneous pool can select without a default", async () => {
  const rows = [baseRow(CRED_B), baseRow(CRED_A)];
  const before = structuredClone(rows);
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith(rows) as never, projectId: "project-1", agentCli: "claude-code",
    allowlist: allowlist({ enabled_credential_ids: [CRED_A, CRED_B], default_credential_id: null }), provider: "anthropic",
  });
  assert.equal(resolved?.id, CRED_A);
  assert.deepEqual(rows, before, "selection/readiness does not mutate credentials or allocate a turn");
});

test("#1002 resolve: pool selection prefers active load, then lifetime assignments", async () => {
  for (const [loads, expected] of [
    [[{ credential_id: CRED_A, active_jobs: 2, total_jobs: 2 }, { credential_id: CRED_B, active_jobs: 0, total_jobs: 10 }], CRED_B],
    [[{ credential_id: CRED_A, active_jobs: 0, total_jobs: 2 }, { credential_id: CRED_B, active_jobs: 0, total_jobs: 3 }], CRED_A],
  ] as const) {
    const result = await resolveProviderCredentialForJob({ db: dbWith([baseRow(CRED_B), baseRow(CRED_A)], [...loads]) as never,
      projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ default_credential_id: null }), provider: "anthropic" });
    assert.equal(result?.id, expected);
  }
});

test("#1002 resolve: an existing authorized Job identity does not rotate with load", async () => {
  const result = await resolveProviderCredentialForJob({ db: dbWith([baseRow(CRED_A), baseRow(CRED_B)],
    [{ credential_id: CRED_A, active_jobs: 20, total_jobs: 20 }]) as never, projectId: "project-1", agentCli: "claude-code",
    allowlist: allowlist({ default_credential_id: null }), provider: "anthropic", existingCredentialId: CRED_A });
  assert.equal(result?.id, CRED_A);
  // #1078/#1096：合法恢复身份始终保持，满额时等待原账号，
  // 不再把缺省变化当成切换凭据的授权。
  const overridden = await resolveProviderCredentialForJob({ db: dbWith([baseRow(CRED_A), baseRow(CRED_B)]) as never,
    projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ default_credential_id: CRED_B }), existingCredentialId: CRED_A });
  assert.equal(overridden?.id, CRED_A, "a recovery identity with room beats even an explicit default");
  const frozenFull = { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 2 } };
  const fallbackToDefault = await resolveProviderCredentialForJob({ db: dbWith([frozenFull, baseRow(CRED_B)],
    [{ credential_id: CRED_A, active_jobs: 2, total_jobs: 2 }]) as never,
    projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ default_credential_id: CRED_B }), existingCredentialId: CRED_A,
    allowCapacityWait: true });
  assert.equal(fallbackToDefault?.id, CRED_A, "a full frozen identity waits without switching accounts");
  assert.equal(fallbackToDefault?.selection?.reason, "capacity_wait");
});

test("#1002 resolve: heterogeneous model defaults and unconfigured pools retain ambiguity refusal", async () => {
  for (const [rows, policy] of [
    [[baseRow(CRED_A), { ...baseRow(CRED_B), settings_config_json: { env: { ANTHROPIC_MODEL: "another-model" } } }], allowlist({ default_credential_id: null })],
    [[baseRow(CRED_A), baseRow(CRED_B)], allowlist({ enabled_credential_ids: undefined, default_credential_id: null })],
  ] as const) await assert.rejects(() => resolveProviderCredentialForJob({ db: dbWith([...rows]) as never, projectId: "project-1",
    agentCli: "claude-code", allowlist: policy, provider: "anthropic" }),
    error => error instanceof ProviderCredentialResolveError && error.code === "provider_credential_multi_match");
});

test("#1002 resolve: an out-of-pool old identity cannot widen scope and unknown load fails closed", async () => {
  const chosen = await resolveProviderCredentialForJob({ db: dbWith([baseRow(CRED_A), baseRow(CRED_B)]) as never,
    projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ enabled_credential_ids: [CRED_B], default_credential_id: null }),
    provider: "anthropic", existingCredentialId: CRED_A });
  assert.equal(chosen?.id, CRED_B);
  await assert.rejects(() => resolveProviderCredentialForJob({ db: dbWith([baseRow(CRED_A), baseRow(CRED_B)],
    [{ credential_id: CRED_A, active_jobs: "unknown", total_jobs: 1 }]) as never, projectId: "project-1", agentCli: "claude-code",
    allowlist: allowlist({ default_credential_id: null }), provider: "anthropic" }),
    error => error instanceof ProviderCredentialResolveError && error.code === "provider_credential_load_unknown");
});

test("#690 resolve: default credential wins among multi-match", async () => {
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([baseRow(CRED_A), baseRow(CRED_B)]) as never,
    projectId: "project-1",
    agentCli: "claude-code",
    allowlist: allowlist({
      enabled_credential_ids: [CRED_A, CRED_B],
      default_credential_id: CRED_B,
    }),
    provider: "anthropic",
  });
  assert.equal(resolved?.id, CRED_B);
});

test("#1078 heterogeneous identities retain the configured default instead of ranking another model", async () => {
  const chosen = await resolveProviderCredentialForJob({ db: dbWith([
    { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 3 } },
    { ...baseRow(CRED_B), settings_config_json: { env: { ANTHROPIC_MODEL: "another-model" } } },
  ], [{ credential_id: CRED_A, active_jobs: 2, total_jobs: 2 }]) as never,
  projectId: "project-1", allowlist: allowlist({ default_credential_id: CRED_A }) });
  assert.equal(chosen?.id, CRED_A, "spare capacity does not authorize switching model identity");
});

test("#690 resolve: cross-project credential excluded", async () => {
  await assert.rejects(
    () => resolveProviderCredentialForJob({
      db: dbWith([{ ...baseRow(CRED_A), project_id: "other-project" }]) as never,
      projectId: "project-1",
      agentCli: "claude-code",
      allowlist: allowlist({ enabled_credential_ids: [CRED_A], default_credential_id: CRED_A }),
      provider: "anthropic",
    }),
    (error: unknown) => error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_allowlist_stale",
  );
});

test("#690 resolve: inactive/revoked credential excluded", async () => {
  await assert.rejects(
    () => resolveProviderCredentialForJob({
      db: dbWith([{ ...baseRow(CRED_A), status: "revoked" }]) as never,
      projectId: "project-1",
      agentCli: "claude-code",
      allowlist: allowlist({ enabled_credential_ids: [CRED_A], default_credential_id: CRED_A }),
      provider: "anthropic",
    }),
    (error: unknown) => error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_allowlist_stale",
  );
});

test("#690 resolve: CLI-incompatible credential excluded when alternative exists", async () => {
  const piOnly = { ...baseRow(CRED_A), agent_cli: "pi" };
  const claude = { ...baseRow(CRED_B), agent_cli: "claude-code" };
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([piOnly, claude]) as never,
    projectId: "project-1",
    agentCli: "claude-code",
    allowlist: allowlist({ enabled_credential_ids: [CRED_A, CRED_B], default_credential_id: null }),
    provider: "anthropic",
  });
  assert.equal(resolved?.id, CRED_B);
});

test("#690 resolve: model filter narrows pool; default still wins", async () => {
  const withModel = baseRow(CRED_A);
  const withoutModel = {
    ...baseRow(CRED_B),
    settings_config_json: { env: { ANTHROPIC_MODEL: "other-model" } },
  };
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([withModel, withoutModel]) as never,
    projectId: "project-1",
    agentCli: "claude-code",
    allowlist: allowlist({ enabled_credential_ids: [CRED_A, CRED_B], default_credential_id: null }),
    provider: "anthropic",
    modelRef: "claude-sonnet-4",
  });
  assert.equal(resolved?.id, CRED_A);
});

test("#707 resolve: CLI mismatch fail-closed (no soft fallback to candidates)", async () => {
  const piOnly = { ...baseRow(CRED_A), agent_cli: "pi" };
  await assert.rejects(
    () => resolveProviderCredentialForJob({
      db: dbWith([piOnly]) as never,
      projectId: "project-1",
      agentCli: "claude-code",
      allowlist: allowlist({ enabled_credential_ids: [CRED_A], default_credential_id: CRED_A }),
      provider: "anthropic",
    }),
    (error: unknown) => {
      if (!(error instanceof ProviderCredentialResolveError)) return false;
      if (error.code !== "provider_credential_cli_mismatch") return false;
      assert.equal(error.repair.category, "permanent_failure");
      assert.equal(
        error.repair.next_action,
        "enable_credential_pinned_to_role_cli_or_change_project_default_credential",
      );
      const observed = error.repair.observed_shape as {
        candidates?: Array<{ credential_id?: string; agent_cli?: string | null; name?: string; secret?: string }>;
      };
      assert.ok(Array.isArray(observed.candidates));
      assert.equal(observed.candidates![0]!.credential_id, CRED_A);
      assert.equal(observed.candidates![0]!.agent_cli, "pi");
      assert.equal(observed.candidates![0]!.name, undefined);
      assert.equal(observed.candidates![0]!.secret, undefined);
      return true;
    },
  );
});

test("#707 resolve: default_credential_id pointing at CLI-mismatched account does not side-path win", async () => {
  const piDefault = { ...baseRow(CRED_A), agent_cli: "pi" };
  const claudeAlt = { ...baseRow(CRED_B), agent_cli: "claude-code" };
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([piDefault, claudeAlt]) as never,
    projectId: "project-1",
    agentCli: "claude-code",
    allowlist: allowlist({
      enabled_credential_ids: [CRED_A, CRED_B],
      default_credential_id: CRED_A,
    }),
    provider: "anthropic",
  });
  assert.equal(resolved?.id, CRED_B);
});

test("#707 resolve: default_credential_id CLI mismatch with no alternative fail-closed", async () => {
  const piDefault = { ...baseRow(CRED_A), agent_cli: "pi" };
  await assert.rejects(
    () => resolveProviderCredentialForJob({
      db: dbWith([piDefault]) as never,
      projectId: "project-1",
      agentCli: "claude-code",
      allowlist: allowlist({ enabled_credential_ids: [CRED_A], default_credential_id: CRED_A }),
      provider: "anthropic",
    }),
    (error: unknown) => error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_cli_mismatch"
      && error.repair.category === "permanent_failure",
  );
});

test("#707 resolve: null agent_cli fail-closed (no longer compatible with every CLI)", async () => {
  const nullCli = { ...baseRow(CRED_A), agent_cli: null };
  await assert.rejects(
    () => resolveProviderCredentialForJob({
      db: dbWith([nullCli]) as never,
      projectId: "project-1",
      agentCli: "claude-code",
      allowlist: allowlist({ enabled_credential_ids: [CRED_A], default_credential_id: CRED_A }),
      provider: "anthropic",
    }),
    (error: unknown) => error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_cli_mismatch",
  );
});

test("#707 resolve: protocol incompatible (claude-code × openai) is model_correctable", async () => {
  // Pin matches role CLI, but provider protocol does not — blocked at resolve layer.
  const bad = { ...baseRow(CRED_A), agent_cli: "claude-code", provider: "openai" };
  await assert.rejects(
    () => resolveProviderCredentialForJob({
      db: dbWith([bad]) as never,
      projectId: "project-1",
      agentCli: "claude-code",
      allowlist: allowlist({ enabled_credential_ids: [CRED_A], default_credential_id: CRED_A }),
      provider: "openai",
    }),
    (error: unknown) => error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_protocol_incompatible"
      && error.repair.category === "model_correctable",
  );
});

test("#757 unique credential supplies CLI despite a different soft preference", async () => {
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([{ ...baseRow(CRED_A), agent_cli: "pi" }]) as never,
    projectId: "project-1",
    preferredAgentCli: "claude-code",
    allowlist: parseProjectAgentAllowlist({}),
  });
  assert.equal(resolved?.agent_cli, "pi");
});

test("#757 cross-CLI ambiguity requires an explicit preference", async () => {
  const input = {
    db: dbWith([baseRow(CRED_A), { ...baseRow(CRED_B), agent_cli: "pi" }]) as never,
    projectId: "project-1",
    allowlist: parseProjectAgentAllowlist({}),
  };
  await assert.rejects(() => resolveProviderCredentialForJob(input), (error: unknown) =>
    error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_multi_match"
      && error.repair.category === "model_correctable");
  assert.equal((await resolveProviderCredentialForJob({ ...input, preferredAgentCli: "pi" }))?.id, CRED_B);
  assert.equal((await resolveProviderCredentialForJob({ ...input, preferredAgentCli: "claude-code" }))?.id, CRED_A);
  assert.equal((await resolveProviderCredentialForJob({
    ...input, allowlist: parseProjectAgentAllowlist({ default_agent_cli: "pi" }),
  }))?.id, CRED_B);
});

test("#757 provider and model narrow candidates before CLI preference", async () => {
  const rows = [baseRow(CRED_A), {
    ...baseRow(CRED_B, "openai"), agent_cli: "pi",
    settings_config_json: { providers: { openai: { models: [{ id: "selected-model" }] } } },
  }];
  const input = { db: dbWith(rows) as never, projectId: "project-1", allowlist: parseProjectAgentAllowlist({}), preferredAgentCli: "claude-code" };
  assert.equal((await resolveProviderCredentialForJob({ ...input, provider: "openai" }))?.id, CRED_B);
  assert.equal((await resolveProviderCredentialForJob({ ...input, modelRef: "selected-model" }))?.id, CRED_B);
  await assert.rejects(() => resolveProviderCredentialForJob({ ...input, modelRef: "missing-model" }), (error: unknown) =>
    error instanceof ProviderCredentialResolveError && error.code === "provider_credential_no_match");
});

test("#757 CLI-only restriction does not implicitly deny every credential", async () => {
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([baseRow(CRED_A), { ...baseRow(CRED_B), agent_cli: "pi" }]) as never,
    projectId: "project-1",
    allowlist: parseProjectAgentAllowlist({ enabled_agent_clis: ["pi"] }),
  });
  assert.equal(resolved?.id, CRED_B);
});

test("#757 stale explicit restrictions require administrator repair without widening", async () => {
  for (const restriction of [{ enabled_credential_ids: [CRED_A] }, { default_credential_id: CRED_A }]) {
    await assert.rejects(() => resolveProviderCredentialForJob({
      db: dbWith([baseRow(CRED_B)]) as never,
      projectId: "project-1",
      allowlist: parseProjectAgentAllowlist(restriction),
    }), (error: unknown) => error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_allowlist_stale"
      && error.repair.category === "permanent_failure"
      && error.repair.next_action === "repair_project_credential_allowlist");
  }
});

test("#757 unconfigured scope follows replacement credentials without mutating policy", async () => {
  const cfg = {};
  const policy = parseProjectAgentAllowlist(cfg);
  const input = { projectId: "project-1", allowlist: policy };
  assert.equal((await resolveProviderCredentialForJob({ ...input, db: dbWith([baseRow(CRED_A)]) as never }))?.id, CRED_A);
  const replacement = { ...baseRow(CRED_B), agent_cli: "dsh", settings_config_json: {
    config: `llm-pi-ai:
  providers:
    anthropic:
      api: anthropic-messages
      baseURL: https://api.anthropic.com
      models:
        - id: claude-sonnet-4
agent-default-model:
  provider: anthropic
  model: claude-sonnet-4
`,
  } };
  assert.equal((await resolveProviderCredentialForJob({ ...input, db: dbWith([replacement]) as never }))?.id, CRED_B);
  assert.deepEqual(cfg, {});
  assert.equal(policy.credential_ids_configured, false);
});

test("#757 project preference precedes global preference; explicit Hub precedes both", async () => {
  const input = {
    db: dbWith([baseRow(CRED_A), { ...baseRow(CRED_B), agent_cli: "pi" }]) as never,
    projectId: "project-1", preferredAgentCli: "claude-code",
    allowlist: parseProjectAgentAllowlist({ default_agent_cli: "pi" }),
  };
  assert.equal((await resolveProviderCredentialForJob(input))?.id, CRED_B);
  assert.equal((await resolveProviderCredentialForJob({ ...input, agentCli: "claude-code" }))?.id, CRED_A);
});

test("#757 global readiness scope excludes project-owned credentials", async () => {
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([baseRow(CRED_A), { ...baseRow(CRED_B), project_id: "other-project" }]) as never,
    projectId: null,
    allowlist: parseProjectAgentAllowlist({}),
  });
  assert.equal(resolved?.id, CRED_A);
});

test("#757 model candidate filter preserves Claude configured selectors", async () => {
  for (const selector of ["fable", "sonnet", "opus", "haiku"]) {
    const resolved = await resolveProviderCredentialForJob({
      db: dbWith([{ ...baseRow(CRED_A), settings_config_json: { env: {
        ANTHROPIC_MODEL: "default-model", [`ANTHROPIC_DEFAULT_${selector.toUpperCase()}_MODEL`]: "mapped-model",
      } } }]) as never,
      projectId: "project-1", modelRef: selector,
      allowlist: parseProjectAgentAllowlist({}),
    });
    assert.equal(resolved?.id, CRED_A);
  }
});

test("#757 Pi model candidate filter handles route prefixes and exact slash ids", async () => {
  for (const [requested, id] of [["deepsonar/grok-4.6", "grok-4.6"], ["openrouter/model", "openrouter/model"]]) {
    const resolved = await resolveProviderCredentialForJob({
      db: dbWith([{ ...baseRow(CRED_A), agent_cli: "pi", settings_config_json: {
        providers: { deepsonar: { models: [{ id }] } },
      } }]) as never,
      projectId: "project-1", modelRef: requested,
      allowlist: parseProjectAgentAllowlist({}),
    });
    assert.equal(resolved?.id, CRED_A);
  }
});

test("#757 rejected model includes a bounded configured catalog repair sample", async () => {
  await assert.rejects(() => resolveProviderCredentialForJob({
    db: dbWith([baseRow(CRED_A)]) as never,
    projectId: "project-1", modelRef: "unconfigured-model",
    allowlist: parseProjectAgentAllowlist({}),
  }), (error: unknown) => {
    assert.ok(error instanceof ProviderCredentialResolveError);
    assert.equal(error.repair.path, "model_ref");
    assert.deepEqual((error.repair.expected as { sample: string[] }).sample, ["claude-sonnet-4"]);
    return true;
  });
});

test("#914 stale member blocks the whole allowlist until explicit repair; empty stays deny-all", async () => {
  const rows = [baseRow(CRED_B)];
  const resolve = (cfg: Record<string, unknown>) => resolveProviderCredentialForJob({
    db: dbWith(rows) as never,
    projectId: "project-1",
    provider: "anthropic",
    modelRef: "claude-sonnet-4",
    allowlist: parseProjectAgentAllowlist(cfg),
  });
  for (const cfg of [
    { enabled_credential_ids: [CRED_A, CRED_B] },
    { default_credential_id: CRED_A },
    { enabled_credential_ids: [CRED_A, CRED_B], default_credential_id: CRED_A },
  ]) {
    const before = structuredClone(cfg);
    await assert.rejects(() => resolve(cfg), (error: unknown) => {
      assert.ok(error instanceof ProviderCredentialResolveError);
      assert.equal(error.code, "provider_credential_allowlist_stale");
      assert.equal(error.repair.category, "permanent_failure");
      assert.equal(error.repair.next_action, "repair_project_credential_allowlist");
      assert.deepEqual(error.repair.observed_shape, { unavailable_count: 1 });
      return true;
    });
    assert.deepEqual(cfg, before, "resolution must not silently remove a stale reference or select another account");
  }
  assert.equal((await resolve({ enabled_credential_ids: [CRED_B], default_credential_id: CRED_B }))?.id, CRED_B);
  const empty = { enabled_credential_ids: [] };
  await assert.rejects(() => resolve(empty), (error: unknown) =>
    error instanceof ProviderCredentialResolveError && error.code === "provider_credential_no_match");
  assert.deepEqual(empty, { enabled_credential_ids: [] });
  assert.equal((await resolve({}))?.id, CRED_B, "missing allowlist remains distinct from explicit []");
});

test("#914 disabled and cross-project references remain stale despite a healthy alternative", async () => {
  for (const unavailable of [
    { ...baseRow(CRED_A), status: "disabled" },
    { ...baseRow(CRED_A), project_id: "other-project" },
  ]) {
    for (const config of [
      { enabled_credential_ids: [CRED_A, CRED_B] },
      { default_credential_id: CRED_A },
      { enabled_credential_ids: [CRED_A, CRED_B], default_credential_id: CRED_A },
    ]) {
      await assert.rejects(() => resolveProviderCredentialForJob({
        db: dbWith([unavailable, baseRow(CRED_B)]) as never,
        projectId: "project-1", provider: "anthropic", modelRef: "claude-sonnet-4",
        allowlist: parseProjectAgentAllowlist(config),
      }), (error: unknown) => error instanceof ProviderCredentialResolveError
        && error.code === "provider_credential_allowlist_stale"
        && error.repair.next_action === "repair_project_credential_allowlist");
    }
  }
});

test("#1078 resolve: a full default credential yields to a roomy same-identity peer", async () => {
  const full = { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 3 } };
  const roomy = baseRow(CRED_B);
  const resolved = await resolveProviderCredentialForJob({
    db: dbWith([full, roomy], [{ credential_id: CRED_A, active_jobs: 3, total_jobs: 3 }]) as never,
    projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ default_credential_id: CRED_A }),
    provider: "anthropic",
  });
  assert.equal(resolved?.id, CRED_B, "max_concurrent capacity is respected even for the configured default");
  assert.deepEqual([full, roomy].map((row) => row.public_metadata_json), [{ max_concurrent: 3 }, {}], "selection does not mutate credentials");
});

test("#1078/#1096 冻结的是满额缺省下的余量同伴，缺省腾出容量后保持冻结身份", async () => {
  const defaultRow = { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 2 } };
  // 首次解析：缺省满额 → 按余量选同伴并冻结（existing 进快照）。
  const firstPick = await resolveProviderCredentialForJob({
    db: dbWith([defaultRow, baseRow(CRED_B)], [{ credential_id: CRED_A, active_jobs: 2, total_jobs: 2 }]) as never,
    projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ default_credential_id: CRED_A }),
    provider: "anthropic",
  });
  assert.equal(firstPick?.id, CRED_B, "a full default yields the roomy peer first");
  // 恢复：缺省已腾出容量，恢复身份仍保持同伴，不切回缺省（避免 SNAPSHOT_STALE）。
  const resumed = await resolveProviderCredentialForJob({
    db: dbWith([defaultRow, baseRow(CRED_B)], [{ credential_id: CRED_A, active_jobs: 0, total_jobs: 5 }]) as never,
    projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ default_credential_id: CRED_A }),
    provider: "anthropic", existingCredentialId: CRED_B,
  });
  assert.equal(resumed?.id, CRED_B, "a freed default must not rotate the frozen recovery identity");
});

test("#1078 resolve: new Jobs rank spare capacity before the default; all-full remains explicit", async () => {
  const defaultRow = { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 3 } };
  const peer = { ...baseRow(CRED_B), public_metadata_json: { max_concurrent: 10 } };
  // 新 Job 的默认 A 剩 1/3，B 剩 10/10，优先 B。恢复身份单独固定。
  const headroom = await resolveProviderCredentialForJob({
    db: dbWith([defaultRow, peer], [{ credential_id: CRED_A, active_jobs: 2, total_jobs: 5 }]) as never,
    projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ default_credential_id: CRED_A }),
    provider: "anthropic",
  });
  assert.equal(headroom?.id, CRED_B, "10/10 spare capacity beats the default's 1/3");
  // 创建路径显式允许等待，全满仍冻结默认身份，同时记录稳定容量错误。
  const crowded = { ...peer, public_metadata_json: { max_concurrent: 2 } };
  const full = await resolveProviderCredentialForJob({
    db: dbWith([defaultRow, crowded], [
      { credential_id: CRED_A, active_jobs: 3, total_jobs: 3 },
      { credential_id: CRED_B, active_jobs: 2, total_jobs: 2 },
    ]) as never, projectId: "project-1", agentCli: "claude-code",
    allowlist: allowlist({ default_credential_id: CRED_A }), provider: "anthropic", allowCapacityWait: true,
  });
  assert.equal(full?.id, CRED_A);
  assert.equal(full?.selection?.error_code, "provider_credential_all_at_capacity");
  // A 剩 1/2，B 剩 3/5，B 比例更高。
  const tight = { ...defaultRow, public_metadata_json: { max_concurrent: 2 } };
  const spread = { ...peer, public_metadata_json: { max_concurrent: 5 } };
  const byRatio = await resolveProviderCredentialForJob({
    db: dbWith([tight, spread], [
      { credential_id: CRED_A, active_jobs: 1, total_jobs: 2 },
      { credential_id: CRED_B, active_jobs: 2, total_jobs: 2 },
    ]) as never, projectId: "project-1", agentCli: "claude-code",
    allowlist: allowlist({ default_credential_id: null }), provider: "anthropic",
  });
  assert.equal(byRatio?.id, CRED_B, "free-capacity ratio orders a pool without default or recovery identity");
});

test("#1078 new Job ties use in-flight, total, assigned, default, then stable ID", async () => {
  const rows = [baseRow(CRED_B), baseRow(CRED_A)];
  for (const [loads, expected] of [
    [[{ credential_id: CRED_A, active_jobs: 1, total_jobs: 1 }, { credential_id: CRED_B, active_jobs: 0, total_jobs: 9 }], CRED_B],
    [[{ credential_id: CRED_A, active_jobs: 0, total_jobs: 2 }, { credential_id: CRED_B, active_jobs: 0, total_jobs: 1 }], CRED_B],
    [[{ credential_id: CRED_A, active_jobs: 0, total_jobs: 2, assigned_jobs: 2 }, { credential_id: CRED_B, active_jobs: 0, total_jobs: 2, assigned_jobs: 1 }], CRED_B],
    [[{ credential_id: CRED_A, active_jobs: 0, total_jobs: 2, assigned_jobs: 1 }, { credential_id: CRED_B, active_jobs: 0, total_jobs: 2, assigned_jobs: 1 }], CRED_A],
  ] as const) {
    const chosen = await resolveProviderCredentialForJob({ db: dbWith(rows, [...loads]) as never,
      projectId: "project-1", allowlist: allowlist({ default_credential_id: CRED_A }) });
    assert.equal(chosen?.id, expected);
  }
  const tied = rows.map(row => ({ ...row, public_metadata_json: { max_concurrent: 3 } }));
  const chosen = await resolveProviderCredentialForJob({ db: dbWith(tied, [
    { credential_id: CRED_A, active_jobs: 1, total_jobs: 2 },
    { credential_id: CRED_B, active_jobs: 1, total_jobs: 2 },
  ]) as never, projectId: "project-1", allowlist: allowlist({ default_credential_id: CRED_B }) });
  assert.equal(chosen?.id, CRED_B, "equal 2/3 ratios and load prefer the default over stable ID");
});

test("#1078 resolve: recovery identity does not bypass capacity limits", async () => {
  const full = { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 2 } };
  const roomy = baseRow(CRED_B);
  const recovered = await resolveProviderCredentialForJob({
    db: dbWith([full, roomy], [{ credential_id: CRED_A, active_jobs: 2, total_jobs: 2 }]) as never,
    projectId: "project-1", agentCli: "claude-code", allowlist: allowlist({ default_credential_id: CRED_A }),
    provider: "anthropic", existingCredentialId: CRED_A, allowCapacityWait: true,
  });
  assert.equal(recovered?.id, CRED_A, "recovery preserves the full frozen identity for claim to recheck");
  assert.equal(recovered?.selection?.reason, "capacity_wait");
});

test("#1078 P1 评审：仍有余量的恢复身份不因负载比例被替换", async () => {
  const left = { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 3 } };
  const right = { ...baseRow(CRED_B), public_metadata_json: { max_concurrent: 3 } };
  const kept = await resolveProviderCredentialForJob({
    db: dbWith([left, right], [
      { credential_id: CRED_A, active_jobs: 2, total_jobs: 2 },
      { credential_id: CRED_B, active_jobs: 0, total_jobs: 0 },
    ]) as never, projectId: "project-1", agentCli: "claude-code",
    allowlist: allowlist({ default_credential_id: null }), provider: "anthropic",
    existingCredentialId: CRED_A,
  });
  assert.equal(kept?.id, CRED_A, "an authorized recovery identity with room must not rotate to a roomier peer");
});

test("#1078 resolve: capacity uses managed metadata instead of arbitrary account meta", async () => {
  const full = { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 1 } };
  const peer = { ...baseRow(CRED_B), meta_json: { max_concurrent: 0 } };
  const result = await resolveProviderCredentialForJob({
    db: dbWith([full, peer], [{ credential_id: CRED_A, active_jobs: 1, total_jobs: 0, assigned_jobs: 0 }]) as never,
    projectId: "project-1", agentCli: "claude-code", provider: "anthropic",
    allowlist: allowlist({ default_credential_id: CRED_A }),
  });
  assert.equal(result?.id, CRED_B, "global credential occupancy can exceed this project's history");
});

test("#1078 resolve: a managed zero limit yields even with no running Jobs", async () => {
  const result = await resolveProviderCredentialForJob({
    db: dbWith([{ ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 0 } }, baseRow(CRED_B)]) as never,
    projectId: "project-1", agentCli: "claude-code", provider: "anthropic",
    allowlist: allowlist({ default_credential_id: CRED_A }),
  });
  assert.equal(result?.id, CRED_B);
});


test("#1078 temporary health failure is excluded after stale authorization validation", async () => {
  const failed = { ...baseRow(CRED_A), health_status: "error" };
  const chosen = await resolveProviderCredentialForJob({ db: dbWith([failed, baseRow(CRED_B)]) as never,
    projectId: "project-1", allowlist: allowlist({ default_credential_id: CRED_A }) });
  assert.equal(chosen?.id, CRED_B);
  assert.equal(chosen?.selection?.candidates.find(row => row.credential_id === CRED_A)?.skipped, "health_error");
  await assert.rejects(() => resolveProviderCredentialForJob({ db: dbWith([failed]) as never,
    projectId: "project-1", allowlist: allowlist({ enabled_credential_ids: [CRED_A] }) }),
  error => error instanceof ProviderCredentialResolveError && error.code === "provider_credential_health_unavailable"
    && error.repair.category === "transient_retryable");
  await assert.rejects(() => resolveProviderCredentialForJob({ db: dbWith([failed, { ...baseRow(CRED_B), status: "disabled" }]) as never,
    projectId: "project-1", allowlist: allowlist({}) }),
  error => error instanceof ProviderCredentialResolveError && error.code === "provider_credential_allowlist_stale");
});

test("#1078 single full credential returns stable capacity feedback or an explicit waiting decision", async () => {
  const db = dbWith([{ ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 0 } }]) as never;
  const input = { db, projectId: "project-1", allowlist: allowlist({ enabled_credential_ids: [CRED_A] }) };
  await assert.rejects(() => resolveProviderCredentialForJob(input), error => error instanceof ProviderCredentialResolveError
    && error.code === "provider_credential_all_at_capacity" && error.repair.category === "transient_retryable"
    && error.repair.next_action === "wait_for_provider_capacity");
  const waiting = await resolveProviderCredentialForJob({ ...input, allowCapacityWait: true });
  assert.equal(waiting?.selection?.reason, "capacity_wait");
  assert.equal(waiting?.selection?.error_code, "provider_credential_all_at_capacity");
  assert.deepEqual(waiting?.selection?.candidates[0]?.capacity?.blocked_by, ["credential"]);
});

test("#1078 model quota excludes a roomy credential whose selected upstream model is full", async () => {
  const fullModel = { ...baseRow(CRED_A), public_metadata_json: { max_concurrent: 10, model_concurrency: { "claude-sonnet-4": 1 } } };
  const chosen = await resolveProviderCredentialForJob({
    db: dbWith([fullModel, baseRow(CRED_B)], [{ credential_id: CRED_A, active_jobs: 1, total_jobs: 1 }]) as never,
    projectId: "project-1", allowlist: allowlist({ default_credential_id: CRED_A }), modelRef: "claude-sonnet-4",
  });
  assert.equal(chosen?.id, CRED_B);
  assert.deepEqual(chosen?.selection?.candidates.find(row => row.credential_id === CRED_A)?.capacity?.blocked_by, ["model"]);
});


test("#1078 Provider capacity is global across credentials and returns retryable feedback", async () => {
  await assert.rejects(() => resolveProviderCredentialForJob({
    db: dbWith([baseRow(CRED_A), baseRow(CRED_B)], [{ credential_id: "third-account", active_jobs: 1, total_jobs: 1 }],
      { maxConcurrentByProvider: { anthropic: 1 } }) as never,
    projectId: "project-1", allowlist: allowlist({ default_credential_id: CRED_A }),
  }), error => error instanceof ProviderCredentialResolveError && error.code === "provider_credential_all_at_capacity");
});


test("#1078 unknown health and catalog-only probe failure remain eligible", async () => {
  for (const health of [{ health_status: "unknown" }, { health_status: "error", health_error_category: "unknown" }]) {
    const result = await resolveProviderCredentialForJob({ db: dbWith([{ ...baseRow(CRED_A), ...health }]) as never,
      projectId: "project-1", allowlist: allowlist({ enabled_credential_ids: [CRED_A] }) });
    assert.equal(result?.id, CRED_A);
    assert.equal(result?.selection?.error_code, null);
    assert.equal(Object.hasOwn(result!.selection!, "capacity_wait"), false);
  }
});

test("#1078 an unhealthy frozen account cannot rotate to a healthy peer", async () => {
  await assert.rejects(() => resolveProviderCredentialForJob({
    db: dbWith([{ ...baseRow(CRED_A), health_status: "error", health_error_category: "network" }, baseRow(CRED_B)]) as never,
    projectId: "project-1", allowlist: allowlist({ default_credential_id: CRED_B }), existingCredentialId: CRED_A,
  }), error => error instanceof ProviderCredentialResolveError && error.code === "provider_credential_health_unavailable");
});

test("#1078 a single credential obeys zero model and Provider limits", async () => {
  for (const [metadata, rules] of [
    [{ model_concurrency: { "claude-sonnet-4": 0 } }, {}],
    [{}, { maxConcurrentByProvider: { anthropic: 0 } }],
  ]) {
    await assert.rejects(() => resolveProviderCredentialForJob({
      db: dbWith([{ ...baseRow(CRED_A), public_metadata_json: metadata }], [], rules) as never,
      projectId: "project-1", allowlist: allowlist({ enabled_credential_ids: [CRED_A] }),
    }), error => error instanceof ProviderCredentialResolveError && error.code === "provider_credential_all_at_capacity");
  }
});

test("#1078 capacity normalizes Claude aliases and Pi routes to the admitted upstream model", async () => {
  for (const row of [
    { ...baseRow(CRED_A), settings_config_json: { env: { ANTHROPIC_MODEL: "sonnet", ANTHROPIC_DEFAULT_SONNET_MODEL: "upstream" } } },
    { ...baseRow(CRED_A), agent_cli: "pi", settings_config_json: { providers: { deepsonar: { models: [{ id: "upstream" }] } } } },
  ]) {
    await assert.rejects(() => resolveProviderCredentialForJob({
      db: dbWith([{ ...row, public_metadata_json: { model_concurrency: { upstream: 0 } } }]) as never,
      projectId: "project-1", allowlist: allowlist({ enabled_credential_ids: [CRED_A] }),
      modelRef: row.agent_cli === "pi" ? "deepsonar/upstream" : "sonnet",
    }), error => error instanceof ProviderCredentialResolveError && error.code === "provider_credential_all_at_capacity");
  }
});
