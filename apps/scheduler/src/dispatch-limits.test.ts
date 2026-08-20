import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import { asConcurrencyLimit, effectiveProjectJobLimit, globalRules, mergeGlobalRulesPatch, rulesForProject } from "./core.js";
import {
  dispatchSkipReason,
  dispatchSlots,
  projectJobLimitForCandidate,
  provisionSlots,
  scanDispatchPages,
  type DispatchCounts,
} from "./dispatcher.js";
import { sql } from "./db.js";
import { parseConcurrencyRulesPatch } from "./routes.js";

function emptyCounts(): DispatchCounts {
  return {
    project: new Map(),
    provider: new Map(),
    credential: new Map(),
    model: new Map(),
    cli: new Map(),
  };
}

function fakeDb(result: unknown, projectResult?: unknown) {
  return ((strings: TemplateStringsArray) => {
    const query = strings.join("");
    return Promise.resolve(query.includes("FROM projects") ? projectResult ?? [] : result);
  }) as unknown as typeof sql;
}

test("effective global caps allow four claude-code jobs when project cap is four", async () => {
  const rules = await globalRules(
    fakeDb([
      {
        rules_json: {
          maxGlobalJobs: 4,
          maxJobsPerProject: 8,
          maxConcurrentProvisioning: 4,
          maxConcurrentByAgentCli: { "claude-code": 4 },
        },
      },
    ]),
  );
  assert.equal(rules.maxGlobalJobs, 4);
  assert.equal(rules.maxJobsPerProject, 4);
  assert.equal(dispatchSlots(rules.maxGlobalJobs, 0), 4);
  assert.equal(provisionSlots(rules.maxConcurrentProvisioning, 0), 4);

  const counts = emptyCounts();
  const candidate = {
    project_id: "project-1",
    agent_cli: "claude-code",
    credential_provider: "",
    credential_id: "",
    model: "",
    credential_metadata: {},
  };
  for (let i = 0; i < 4; i += 1) {
    assert.equal(dispatchSkipReason(candidate, counts, rules, rules.maxJobsPerProject), null);
    counts.project.set("project-1", (counts.project.get("project-1") ?? 0) + 1);
    counts.cli.set("claude-code", (counts.cli.get("claude-code") ?? 0) + 1);
  }
  assert.equal(dispatchSkipReason(candidate, counts, rules, rules.maxJobsPerProject), "project");
});

test("CLI cap blocks the fifth job even when project cap is higher", async () => {
  const rules = await globalRules(
    fakeDb([
      {
        rules_json: {
          maxGlobalJobs: 8,
          maxJobsPerProject: 8,
          maxConcurrentProvisioning: 4,
          maxConcurrentByAgentCli: { "claude-code": 4 },
        },
      },
    ]),
  );
  const counts = emptyCounts();
  counts.cli.set("claude-code", 4);
  assert.equal(
    dispatchSkipReason(
      {
        project_id: "project-1",
        agent_cli: "claude-code",
        credential_provider: "",
        credential_id: "",
        model: "",
        credential_metadata: {},
      },
      counts,
      rules,
      rules.maxJobsPerProject,
    ),
    "agent_cli",
  );
});

test("project cap of two blocks the third job", async () => {
  const rules = await globalRules(
    fakeDb([
      {
        rules_json: {
          maxGlobalJobs: 4,
          maxJobsPerProject: 2,
          maxConcurrentProvisioning: 4,
          maxConcurrentByAgentCli: {},
        },
      },
    ]),
  );
  const counts = emptyCounts();
  counts.project.set("project-1", 2);
  assert.equal(
    dispatchSkipReason(
      {
        project_id: "project-1",
        agent_cli: "claude-code",
        credential_provider: "",
        credential_id: "",
        model: "",
        credential_metadata: {},
      },
      counts,
      rules,
      rules.maxJobsPerProject,
    ),
    "project",
  );
});

test("model concurrency uses upstream model while preserving the CLI selector", () => {
  const counts = emptyCounts();
  counts.model.set("credential-1\u0000grok-4.5", 1);
  assert.equal(
    dispatchSkipReason(
      {
        project_id: "project-1",
        agent_cli: "claude-code",
        credential_provider: "anthropic",
        credential_id: "credential-1",
        model: "fable",
        upstream_model: "grok-4.5",
        credential_metadata: { model_concurrency: { "grok-4.5": 1 } },
      },
      counts,
      {
        maxConcurrentByProvider: {},
        maxConcurrentByAgentCli: {},
      },
      8,
    ),
    "model",
  );
});

test("paged scan continues past a 500-job ineligible head", () => {
  const head = Array.from({ length: 500 }, (_, index) => ({ eligible: false, index }));
  const tail = [{ eligible: true, index: 500 }];
  assert.deepEqual(
    scanDispatchPages([head, tail], 1, (candidate) => candidate.eligible),
    tail,
  );
});

test("globalRules reads changed settings on the next claim without a process restart", async () => {
  let rows: unknown[] = [{ rules_json: { maxGlobalJobs: 4, maxJobsPerProject: 4, maxConcurrentProvisioning: 3 } }];
  const db = ((strings: TemplateStringsArray) => {
    void strings;
    return Promise.resolve(rows);
  }) as unknown as typeof sql;
  assert.equal((await globalRules(db)).maxGlobalJobs, 4);
  assert.equal((await globalRules(db)).maxConcurrentProvisioning, 3);
  rows = [{ rules_json: { maxGlobalJobs: 6, maxJobsPerProject: 2, maxConcurrentProvisioning: 5 } }];
  const changed = await globalRules(db);
  assert.equal(changed.maxGlobalJobs, 6);
  assert.equal(changed.maxJobsPerProject, 2);
  assert.equal(changed.maxConcurrentProvisioning, 5);
});

test("invalid persisted caps fall back and project rules cannot widen global caps", async () => {
  const global = await globalRules(
    fakeDb([
      {
        rules_json: { maxGlobalJobs: -1, maxJobsPerProject: 1001 },
      },
    ]),
  );
  assert.equal(global.maxGlobalJobs, config.limits.maxGlobalJobs);
  assert.equal(global.maxJobsPerProject, config.limits.maxJobsPerProject);
  assert.equal(global.maxConcurrentProvisioning, config.limits.maxConcurrentProvisioning);
  assert.equal(asConcurrencyLimit("not-a-number", 6), 6);

  const project = await rulesForProject(
    fakeDb(
      [{ rules_json: { maxGlobalJobs: 4, maxJobsPerProject: 3 } }],
      [{ config_json: { rules: { maxGlobalJobs: 999, maxJobsPerProject: 999 } } }],
    ),
    "project-1",
  );
  assert.equal(project.maxGlobalJobs, 4);
  assert.equal(project.maxJobsPerProject, 3);
  assert.equal(project.maxConcurrentJobs, 3);
  assert.equal(project.maxConcurrentJobsSource, "global");
  assert.equal(project.maxConcurrentProvisioning, config.limits.maxConcurrentProvisioning);
});

test("concurrency caps reject boolean/object/null and only accept JSON numbers", () => {
  assert.equal(asConcurrencyLimit(true, 6), 6);
  assert.equal(asConcurrencyLimit({}, 6), 6);
  assert.equal(asConcurrencyLimit(null, 6), 6);
  assert.throws(() => parseConcurrencyRulesPatch({ maxGlobalJobs: true }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxGlobalJobs: {} }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxGlobalJobs: null }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentProvisioning: true }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentProvisioning: 0 }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentProvisioning: 1001 }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByAgentCli: { "claude-code": true } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByAgentCli: { "claude-code": null } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByAgentCli: { "claude-code": {} } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByProvider: { anthropic: true } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByProvider: { anthropic: null } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByProvider: { anthropic: {} } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentJobs: true }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentJobs: {} }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentJobs: -1 }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentJobs: 1001 }));
  assert.throws(() => parseConcurrencyRulesPatch({ stallSec: -1 }));
  assert.throws(() => parseConcurrencyRulesPatch({ jobTokenMaxRequests: 1_000_001 }));
  assert.throws(() => parseConcurrencyRulesPatch({ provisionTimeoutSec: 10 }));
  assert.deepEqual(parseConcurrencyRulesPatch({ stallSec: 0, jobTokenMaxRequests: 0, provisionTimeoutSec: 400 }), {
    stallSec: 0,
    jobTokenMaxRequests: 0,
    provisionTimeoutSec: 400,
  });
  assert.deepEqual(parseConcurrencyRulesPatch({ maxConcurrentJobs: 0 }), { maxConcurrentJobs: 0 });
  assert.deepEqual(parseConcurrencyRulesPatch({ maxConcurrentJobs: null }), { maxConcurrentJobs: null });
  assert.deepEqual(parseConcurrencyRulesPatch({ maxGlobalJobs: 4, maxConcurrentProvisioning: 3, maxConcurrentByAgentCli: { "claude-code": 4 } }), {
    maxGlobalJobs: 4,
    maxConcurrentProvisioning: 3,
    maxConcurrentByAgentCli: { "claude-code": 4 },
  });
});

test("global settings patches deep-merge CLI and provider maps", () => {
  const merged = mergeGlobalRulesPatch(
    {
      maxConcurrentByAgentCli: { "claude-code": 4, codex: 2 },
      maxConcurrentByProvider: { anthropic: 3 },
      maxGlobalJobs: 6,
      maxConcurrentProvisioning: 2,
    },
    {
      maxConcurrentByAgentCli: { "claude-code": 5 },
      maxConcurrentByProvider: { openai: 2 },
      maxConcurrentProvisioning: 5,
    },
  );
  assert.deepEqual(merged.maxConcurrentByAgentCli, { "claude-code": 5, codex: 2 });
  assert.deepEqual(merged.maxConcurrentByProvider, { anthropic: 3, openai: 2 });
  assert.equal(merged.maxConcurrentProvisioning, 5);
});

test("provisioning slots never exceed the persisted hard cap", () => {
  assert.equal(provisionSlots(2, 0), 2);
  assert.equal(provisionSlots(2, 1), 1);
  assert.equal(provisionSlots(2, 2), 0);
  assert.equal(provisionSlots(2, 3), 0);
});

test("project maxConcurrentJobs inherits, tightens, and cannot widen the global cap", async () => {
  assert.deepEqual(effectiveProjectJobLimit(6, undefined), { limit: 6, source: "global" });
  assert.deepEqual(effectiveProjectJobLimit(6, null), { limit: 6, source: "global" });
  assert.deepEqual(effectiveProjectJobLimit(6, 2), { limit: 2, source: "project" });
  assert.deepEqual(effectiveProjectJobLimit(6, 0), { limit: 0, source: "project" });
  assert.deepEqual(effectiveProjectJobLimit(6, 999), { limit: 6, source: "project" });

  const inherited = await rulesForProject(
    fakeDb(
      [{ rules_json: { maxGlobalJobs: 12, maxJobsPerProject: 6 } }],
      [{ config_json: { rules: {} } }],
    ),
    "project-1",
  );
  assert.equal(inherited.maxConcurrentJobs, 6);
  assert.equal(inherited.maxConcurrentJobsSource, "global");

  const tightened = await rulesForProject(
    fakeDb(
      [{ rules_json: { maxGlobalJobs: 12, maxJobsPerProject: 6 } }],
      [{ config_json: { rules: { maxConcurrentJobs: 2 } } }],
    ),
    "project-1",
  );
  assert.equal(tightened.maxJobsPerProject, 6);
  assert.equal(tightened.maxConcurrentJobs, 2);
  assert.equal(tightened.maxConcurrentJobsSource, "project");

  const clamped = await rulesForProject(
    fakeDb(
      [{ rules_json: { maxGlobalJobs: 12, maxJobsPerProject: 6 } }],
      [{ config_json: { rules: { maxConcurrentJobs: 20 } } }],
    ),
    "project-1",
  );
  assert.equal(clamped.maxConcurrentJobs, 6);
  assert.equal(clamped.maxConcurrentJobsSource, "project");
});

test("changing stallSec and jobTokenMaxRequests is visible to the next globalRules read", async () => {
  const first = await globalRules(fakeDb([{ rules_json: { stallSec: 900, jobTokenMaxRequests: 500 } }]));
  const next = await globalRules(fakeDb([{ rules_json: { stallSec: 3_600, jobTokenMaxRequests: 0 } }]));
  assert.equal(first.stallSec, 900);
  assert.equal(first.jobTokenMaxRequests, 500);
  assert.equal(next.stallSec, 3_600);
  assert.equal(next.jobTokenMaxRequests, 0);

  const project = await rulesForProject(
    fakeDb(
      [{ rules_json: { stallSec: 900, provisionTimeoutSec: 400 } }],
      [{ config_json: { rules: { stallSec: 2_000, provisionTimeoutSec: 1_200 } } }],
    ),
    "project-1",
  );
  assert.equal(project.stallSec, 2_000);
  assert.equal(project.provisionTimeoutSec, 400);
});

test("claim candidates carry their project policy and never fall back when it is missing", () => {
  assert.equal(projectJobLimitForCandidate({
    project_config_json: { rules: { maxConcurrentJobs: 0 } },
  }, 6), 0);
  assert.throws(
    () => projectJobLimitForCandidate({}, 6),
    /DISPATCH_PROJECT_CONFIG_MISSING/,
  );
});

test("a full project quota does not skip another project's candidate", () => {
  const counts = emptyCounts();
  counts.project.set("project-a", 2);
  const rules = { maxConcurrentByProvider: {}, maxConcurrentByAgentCli: {} };
  assert.equal(
    dispatchSkipReason(
      {
        project_id: "project-a",
        agent_cli: "claude-code",
        credential_provider: "",
        credential_id: "",
        model: "",
        credential_metadata: {},
      },
      counts,
      rules,
      2,
    ),
    "project",
  );
  assert.equal(
    dispatchSkipReason(
      {
        project_id: "project-b",
        agent_cli: "claude-code",
        credential_provider: "",
        credential_id: "",
        model: "",
        credential_metadata: {},
      },
      counts,
      rules,
      6,
    ),
    null,
  );
  assert.equal(
    dispatchSkipReason(
      {
        project_id: "project-c",
        agent_cli: "claude-code",
        credential_provider: "",
        credential_id: "",
        model: "",
        credential_metadata: {},
      },
      counts,
      rules,
      0,
    ),
    "project",
  );
});
