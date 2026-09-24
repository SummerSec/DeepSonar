import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderCredentialResolveError,
  resolveProviderCredentialForJob,
} from "./resolve-credential.js";
import { parseProjectAgentAllowlist } from "../project-agent-allowlist/policy.js";

const CRED_A = "11111111-1111-4111-8111-111111111111";
const CRED_B = "22222222-2222-4222-8222-222222222222";

function dbWith(rows: Array<Record<string, unknown>>) {
  const query = async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("FROM credentials")) {
      return rows.filter((row) => {
        if (sql.includes("status = 'active'") && row.status !== "active") return false;
        return true;
      });
    }
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

test("#690 resolve: multi-match without default fail-closed", async () => {
  await assert.rejects(
    () => resolveProviderCredentialForJob({
      db: dbWith([baseRow(CRED_A), baseRow(CRED_B)]) as never,
      projectId: "project-1",
      agentCli: "claude-code",
      allowlist: allowlist({ enabled_credential_ids: [CRED_A, CRED_B], default_credential_id: null }),
      provider: "anthropic",
    }),
    (error: unknown) => error instanceof ProviderCredentialResolveError
      && error.code === "provider_credential_multi_match",
  );
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
      && error.code === "provider_credential_no_match",
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
      && error.code === "provider_credential_no_match",
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
