import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CVSS_CALCULATOR,
  normalizeFindingProposal,
  normalizeFindingScoring,
  resolveFindingProtocol,
} from "./finding-protocol.js";

test("finding protocol resolves task over project over global and replaces lists", () => {
  const effective = resolveFindingProtocol(
    {
      mode: "agent_choice",
      allowed_profiles: ["general", "quality.bug"],
      display_name: "global",
      scoring: { accepted_versions: ["4.0", "3.1"] },
    },
    {
      default_profile: "quality.bug",
      display_name: "project",
    },
    {
      mode: "fixed",
      allowed_profiles: ["general"],
      default_profile: "general",
    },
  );
  assert.equal(effective.mode, "fixed");
  assert.equal(effective.default_profile, "general");
  assert.deepEqual(effective.allowed_profiles, ["general"]);
  assert.deepEqual(effective.scoring.accepted_versions, ["4.0", "3.1"]);
  assert.equal(effective.display_name, "project");
  assert.equal(effective.source, "task");
});

test("fixed and allowed profile boundaries reject Agent overrides", () => {
  const fixed = resolveFindingProtocol(undefined, undefined, {
    mode: "fixed",
    default_profile: "general",
    allowed_profiles: ["general"],
  });
  assert.throws(
    () => normalizeFindingProposal({ title: "x", profile: "quality.bug" }, fixed),
    /fixed to general/,
  );
  assert.equal(normalizeFindingProposal({ title: "x" }, fixed).profile, "general");

  const choice = resolveFindingProtocol(undefined, undefined, {
    mode: "agent_choice",
    default_profile: "general",
    allowed_profiles: ["general", "quality.bug"],
  });
  assert.equal(normalizeFindingProposal({ title: "x", profile: "quality.bug" }, choice).profile, "quality.bug");
  assert.throws(
    () => normalizeFindingProposal({ title: "x", profile: "security.vulnerability" }, choice),
    /not allowed/,
  );

  const unscored = normalizeFindingProposal({ title: "generic finding" }, choice);
  assert.equal(unscored.profile, "general");
  assert.equal(unscored.severity, undefined);
  assert.equal(unscored.scoring, undefined);
  assert.equal("suggest_verify" in unscored, false);

  const hybrid = resolveFindingProtocol(undefined, undefined, {
    mode: "hybrid",
    default_profile: "general",
    allowed_profiles: ["general", "quality.bug"],
  });
  assert.equal(normalizeFindingProposal({ title: "default" }, hybrid).profile, "general");
  assert.equal(
    normalizeFindingProposal({ title: "override", profile: "quality.bug" }, hybrid).profile,
    "quality.bug",
  );
});

test("Scheduler recomputes official FIRST CVSS 4.0 and 3.1 examples", () => {
  const cases = [
    ["4.0", "CVSS:4.0/AV:L/AC:L/AT:P/PR:L/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", 7.3, "high", "hard"],
    ["4.0", "CVSS:4.0/AV:N/AC:H/AT:P/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:P", 8.2, "high", "hard"],
    ["4.0", "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H", 10, "critical", "easy"],
    ["3.1", "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:L/A:H", 9.9, "critical", "medium"],
  ] as const;
  for (const [version, vector, score, severity, exploitability] of cases) {
    const normalized = normalizeFindingScoring("security.vulnerability", {
      standard: "CVSS",
      version,
      vector,
      base_score: 0.1,
    });
    assert.equal(normalized.base_score, score);
    assert.equal(normalized.base_severity, severity);
    assert.equal(normalized.exploitability_label, exploitability);
    assert.equal(normalized.reported_base_score, 0.1);
    assert.equal(normalized.source, "system_recomputed");
    assert.equal(normalized.calculator, CVSS_CALCULATOR);
  }
});

test("unknown CVSS versions preserve raw input without fabricating a score", () => {
  const normalized = normalizeFindingScoring("security.vulnerability", {
    standard: "CVSS",
    version: "5.0",
    vector: "CVSS:5.0/AV:N/FUTURE:X",
    metrics: { FUTURE: "X" },
    base_score: 10,
  });
  assert.equal(normalized.status, "unsupported_version");
  assert.equal(normalized.base_score, null);
  assert.equal(normalized.base_severity, null);
  assert.equal(normalized.calculator, null);
  assert.equal(normalized.reported_base_score, 10);
  assert.deepEqual(normalized.metrics, { FUTURE: "X" });
});

test("effective scoring policy enforces accepted and required scoring", () => {
  const protocol = resolveFindingProtocol(undefined, undefined, {
    mode: "fixed",
    default_profile: "security.vulnerability",
    allowed_profiles: ["security.vulnerability"],
    scoring: {
      accepted_versions: ["4.0"],
      require_scoring_for_profiles: ["security.vulnerability"],
    },
  });
  assert.throws(
    () => normalizeFindingProposal({ title: "x" }, protocol),
    /requires scoring/,
  );
  assert.throws(
    () => normalizeFindingProposal({
      title: "x",
      scoring: {
        standard: "CVSS",
        version: "3.1",
        vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      },
    }, protocol),
    /not accepted/,
  );
});

test("normalizeFindingProposal keeps declared quantities", () => {
  const protocol = resolveFindingProtocol(undefined, undefined, {
    mode: "fixed",
    default_profile: "general",
    allowed_profiles: ["general"],
  });
  const quantities = [{
    value: 70,
    unit: "BPF_CALL sites",
    basis: "raw opcode count, not helper invocations",
  }];
  const normalized = normalizeFindingProposal({
    title: "BPF call inventory",
    summary: "Counted BPF_CALL sites without folding them into helper calls.",
    quantities,
  }, protocol);
  assert.deepEqual(normalized.quantities, quantities);
});

test("leftover suggest_verify is gone from contract, persist, and Agent-facing copy", () => {
  const sources = [
    new URL("../../../packages/shared-types/src/index.ts", import.meta.url),
    new URL("./finding-protocol.ts", import.meta.url),
    new URL("./domains/event-ingestion/side-effects.ts", import.meta.url),
    new URL("./dispatcher.ts", import.meta.url),
    new URL("./platform-tools.ts", import.meta.url),
  ];
  for (const source of sources) {
    assert.doesNotMatch(readFileSync(source, "utf8"), /suggest_verify/);
  }
});

test("Job finding protocol only reads the frozen canvas snapshot", () => {
  const core = readFileSync(new URL("./core.ts", import.meta.url), "utf8");
  const executor = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
  assert.match(core, /FROZEN_FINDING_PROTOCOL_MISSING/);
  assert.match(executor, /FROZEN_FINDING_PROTOCOL_MISSING/);
  assert.doesNotMatch(core, /Compatibility for canvases created before schema v20/);
  assert.doesNotMatch(executor, /Compatibility for pre-v20 canvases/);
  const fn = core.slice(core.indexOf("async function findingProtocolForJob"), core.indexOf("export async function ingestEvent"));
  assert.match(fn, /FROZEN_FINDING_PROTOCOL_MISSING/);
  assert.doesNotMatch(fn, /resolveFindingProtocol\(/);
});
