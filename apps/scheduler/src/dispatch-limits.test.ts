import assert from "node:assert/strict";
import test from "node:test";
import { asConcurrencyLimit, globalRules, mergeGlobalRulesPatch, rulesForProject } from "./core.js";
import { dispatchSkipReason, dispatchSlots, scanDispatchPages, type DispatchCounts } from "./dispatcher.js";
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
          maxConcurrentByAgentCli: { "claude-code": 4 },
        },
      },
    ]),
  );
  assert.equal(rules.maxGlobalJobs, 4);
  assert.equal(rules.maxJobsPerProject, 4);
  assert.equal(dispatchSlots(rules.maxGlobalJobs, 0), 4);

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
    assert.equal(dispatchSkipReason(candidate, counts, rules), null);
    counts.project.set("project-1", (counts.project.get("project-1") ?? 0) + 1);
    counts.cli.set("claude-code", (counts.cli.get("claude-code") ?? 0) + 1);
  }
  assert.equal(dispatchSkipReason(candidate, counts, rules), "project");
});

test("CLI cap blocks the fifth job even when project cap is higher", async () => {
  const rules = await globalRules(
    fakeDb([
      {
        rules_json: {
          maxGlobalJobs: 8,
          maxJobsPerProject: 8,
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
    ),
    "project",
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
  let rows: unknown[] = [{ rules_json: { maxGlobalJobs: 4, maxJobsPerProject: 4 } }];
  const db = ((strings: TemplateStringsArray) => {
    void strings;
    return Promise.resolve(rows);
  }) as unknown as typeof sql;
  assert.equal((await globalRules(db)).maxGlobalJobs, 4);
  rows = [{ rules_json: { maxGlobalJobs: 6, maxJobsPerProject: 2 } }];
  const changed = await globalRules(db);
  assert.equal(changed.maxGlobalJobs, 6);
  assert.equal(changed.maxJobsPerProject, 2);
});

test("invalid persisted caps fall back and project rules cannot widen global caps", async () => {
  const global = await globalRules(
    fakeDb([
      {
        rules_json: { maxGlobalJobs: -1, maxJobsPerProject: 1001 },
      },
    ]),
  );
  assert.equal(global.maxGlobalJobs, 12);
  assert.equal(global.maxJobsPerProject, 4);
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
});

test("concurrency caps reject boolean/object/null and only accept JSON numbers", () => {
  assert.equal(asConcurrencyLimit(true, 6), 6);
  assert.equal(asConcurrencyLimit({}, 6), 6);
  assert.equal(asConcurrencyLimit(null, 6), 6);
  assert.throws(() => parseConcurrencyRulesPatch({ maxGlobalJobs: true }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxGlobalJobs: {} }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxGlobalJobs: null }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByAgentCli: { "claude-code": true } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByAgentCli: { "claude-code": null } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByAgentCli: { "claude-code": {} } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByProvider: { anthropic: true } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByProvider: { anthropic: null } }));
  assert.throws(() => parseConcurrencyRulesPatch({ maxConcurrentByProvider: { anthropic: {} } }));
  assert.deepEqual(parseConcurrencyRulesPatch({ maxGlobalJobs: 4, maxConcurrentByAgentCli: { "claude-code": 4 } }), {
    maxGlobalJobs: 4,
    maxConcurrentByAgentCli: { "claude-code": 4 },
  });
});

test("global settings patches deep-merge CLI and provider maps", () => {
  const merged = mergeGlobalRulesPatch(
    {
      maxConcurrentByAgentCli: { "claude-code": 4, codex: 2 },
      maxConcurrentByProvider: { anthropic: 3 },
      maxGlobalJobs: 6,
    },
    {
      maxConcurrentByAgentCli: { "claude-code": 5 },
      maxConcurrentByProvider: { openai: 2 },
    },
  );
  assert.deepEqual(merged.maxConcurrentByAgentCli, { "claude-code": 5, codex: 2 });
  assert.deepEqual(merged.maxConcurrentByProvider, { anthropic: 3, openai: 2 });
});
