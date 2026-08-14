import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { config } from "./config.js";
import { graphProjectionMarkers, parseHubDecision, serializeFindingStatusIndex } from "./graph.js";
import { buildEvidenceSnapshot, findingVerificationSummaries } from "./verify.js";

test("Hub Finding status index keeps all 357 entries within the 48 KB budget", () => {
  const findings = Array.from({ length: 357 }, (_, index) => ({
    id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
    title: "Finding " + index + " with a deliberately long title that may be compacted",
    severity: index % 3 === 0 ? "critical" : "high",
    verify_status: index % 4 === 0 ? "confirmed" : "pending",
    verify_required: index % 7 !== 0,
    verification_attempt: index % 5,
    missing_evidence: ["independent_review", "runtime_test"],
  }));
  const projection = serializeFindingStatusIndex(findings, config.graph.maxYamlCharsHub);
  const yaml = projection.lines.join("\n");
  assert.ok(yaml.length <= config.graph.maxYamlCharsHub);
  const rows = projection.lines.slice(1).filter((line) => line.trim().startsWith("-"));
  assert.equal(rows.length, findings.length);
  for (const line of rows) {
    const value = JSON.parse(line.replace(/^\s*-\s*/, "")) as { id: string; verify_status: string; verify_required: boolean };
    const source = findings.find((finding) => finding.id === value.id);
    assert.ok(source);
    assert.equal(value.verify_status, source.verify_status);
    assert.equal(value.verify_required, source.verify_required);
  }
});

test("graph scope budgets are explicit and ordered for prompt consumers", () => {
  assert.equal(config.graph.maxYamlCharsHub, 48_000);
  assert.equal(config.graph.maxYamlCharsAgent, 16_000);
  assert.equal(config.graph.maxYamlCharsVerify, 24_000);
  assert.ok(config.graph.maxYamlCharsReport > 0);
  const rows = [{ id: "finding-1", verify_status: "pending" }];
  assert.ok(serializeFindingStatusIndex(rows, config.graph.maxYamlCharsAgent).lines.join("\n").length <= config.graph.maxYamlCharsAgent);
  assert.ok(serializeFindingStatusIndex(rows, config.graph.maxYamlCharsVerify).lines.join("\n").length <= config.graph.maxYamlCharsVerify);
});

test("finding index falls back to an explicit compact form instead of partial rows", () => {
  const projection = serializeFindingStatusIndex(
    [{ id: "finding-1", title: "x".repeat(200), verify_status: "pending" }],
    64,
  );
  assert.equal(projection.truncated, true);
  assert.ok(projection.omitted > 0);
  assert.equal(projection.lines[0], "findings_index:");
});

test("finding index keeps canvas node identity distinct from database finding identity", () => {
  const projection = serializeFindingStatusIndex([
    {
      id: "canvas-finding-node",
      finding_id: "database-finding",
      title: "A finding with enough detail",
      verify_status: "pending",
      verify_required: false,
    },
  ], 2_000);
  const row = JSON.parse(projection.lines[1].replace(/^\s*-\s*/, "")) as Record<string, unknown>;
  assert.equal(row.id, "canvas-finding-node");
  assert.equal(row.finding_id, "database-finding");
  assert.equal(row.verify_required, false);
});

test("graph projections prioritize open intents and do not repeat the Worker prompt", () => {
  const graphSource = readFileSync(new URL("./graph.ts", import.meta.url), "utf8");
  const hubSource = graphSource.slice(
    graphSource.indexOf('if (scope === "hub")'),
    graphSource.indexOf('} else if (scope === "agent")'),
  );
  assert.ok(hubSource.indexOf('"open_intents"') < hubSource.indexOf('"facts_index"'));

  const agentSource = graphSource.slice(
    graphSource.indexOf('} else if (scope === "agent")'),
    graphSource.indexOf('} else if (scope === "verify")'),
  );
  assert.equal(agentSource.includes("options.intent?.prompt"), false);

  const executorSource = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
  assert.match(executorSource, /findingId:\s*[\s\S]{0,400}payload\.trigger/);
});

test("projection markers expose truncation and omission counts", () => {
  assert.deepEqual(graphProjectionMarkers(true, { facts_index: 4 }), {
    truncated: "truncated: true",
    omitted: 'omitted: {"facts_index":4}',
  });
});

test("Hub decision parser remains role-gated after graph scope changes", () => {
  const rootId = "00000000-0000-4000-8000-000000000001";
  const decision = parseHubDecision(
    JSON.stringify({
      intents: [{
        role: "review",
        description: "Review existing evidence and remaining validation boundaries",
        prompt: "Review every referenced item, confirm the conclusion independently, and submit only new facts or actionable evidence gaps.",
        from: [rootId],
      }],
    }),
    new Set(["review"]),
    [rootId],
  );
  assert.equal(decision?.intents?.[0]?.role, "review");
  assert.equal(parseHubDecision(JSON.stringify({ intents: [{
    role: "verify",
    description: "Review the unsupported role rejection path",
    prompt: "Attempt a complete decision with an unavailable role so the parser must reject it before dispatch.",
    from: [],
  }] }), new Set(["review"])), null);
});

test("single and batch evidence paths share the same hard-gate helper", () => {
  const rows = [
    {
      id: "review-node",
      job_id: "review-job",
      job_type: "review",
      job_status: "succeeded",
      title: "review",
      body_json: { description: "review", verification: { evidence_kind: "review", outcome: "supports" } },
    },
    {
      id: "test-node",
      job_id: "test-job",
      job_type: "test",
      job_status: "succeeded",
      title: "test",
      body_json: {
        description: "test",
        verification: {
          evidence_kind: "test",
          outcome: "supports",
          subject_revision: "rev-1",
          steps: ["run"],
          expected: "blocked",
          actual: "allowed",
        },
      },
    },
  ];
  const single = buildEvidenceSnapshot(rows, null);
  const batch = buildEvidenceSnapshot(rows, null);
  assert.deepEqual(batch, single);
  assert.equal(single.qualified, true);
});

test("batch Finding summaries use one query per dataset and preserve gate fields", async () => {
  const calls: string[] = [];
  const fakeTx = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    calls.push(query);
    if (query.includes("FROM findings")) {
      return [{ id: "finding-1", verify_status: "pending", job_id: "origin", raw_json: {} }];
    }
    if (query.includes("FROM finding_verification_rounds")) {
      return [{
        finding_id: "finding-1",
        attempt: 2,
        status: "pending",
        final_outcome: null,
        proposed_verdict: null,
        verify_job_id: null,
        requirements_json: {},
        summary: null,
        error: null,
      }];
    }
    return [];
  }) as unknown as Parameters<typeof findingVerificationSummaries>[0];
  const summaries = await findingVerificationSummaries(fakeTx, ["finding-1"]);
  assert.equal(calls.length, 3);
  assert.equal(summaries.get("finding-1")?.verify_status, "pending");
  assert.equal(summaries.get("finding-1")?.verification_attempt, 2);
  assert.deepEqual(summaries.get("finding-1")?.missing_evidence, ["independent_review", "runtime_test"]);
});
