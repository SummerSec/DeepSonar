import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_HYPOTHESIS_STRATEGY_ID,
  deriveHypothesisAfterRefute,
  evaluateResearchStance,
  frozenResearchHypothesisMeta,
  projectResearchDecisionToHub,
  researchInputFingerprint,
  type ResearchHypothesis,
} from "./research-hypothesis-loop.js";

function hyp(over: Partial<ResearchHypothesis> = {}): ResearchHypothesis {
  const claim = over.claim ?? "user-controlled id reaches unsanitized SQL";
  const args = over.arguments ?? [];
  return {
    hypothesis_id: "h-1",
    version: 1,
    claim,
    status: "proposed",
    arguments: args,
    input_fingerprint:
      over.input_fingerprint ??
      researchInputFingerprint({
        claim,
        subject_revision: "abc123",
        argument_statements: args.map((a) => a.statement),
      }),
    budget_remaining: 3,
    ...over,
  };
}

test("frozen meta keeps Verify Fact-consumer boundary", () => {
  const meta = frozenResearchHypothesisMeta();
  assert.equal(meta.strategy_id, RESEARCH_HYPOTHESIS_STRATEGY_ID);
  assert.equal(meta.no_auto_confirm_from_missing_refutation, true);
  assert.match(String(meta.verify_boundary), /Fact/);
});

test("no counter-evidence alone is NOT confirmation", () => {
  const decision = evaluateResearchStance(
    hyp({
      arguments: [
        {
          kind: "open_assumption",
          statement: "没有找到反证",
          citations: [],
        },
      ],
    }),
  );
  assert.equal(decision.stance, "insufficient");
  assert.equal(decision.missing_refutation_is_not_confirmation, true);
  assert.notEqual(decision.next_action, "await_verify_facts");
  assert.ok(decision.reasons.some((r) => /正向证据|confirmed/i.test(r)));
});

test("positive support with citations can be supported (Verify still owns confirm)", () => {
  const decision = evaluateResearchStance(
    hyp({
      arguments: [
        {
          kind: "supporting",
          statement: "HTTP id flows into string-concat SQL without binding",
          citations: [{ fact_id: "fact-1", job_id: "job-review-1" }],
        },
      ],
    }),
  );
  assert.equal(decision.stance, "supported");
  assert.equal(decision.has_positive_support, true);
  assert.equal(decision.next_action, "await_verify_facts");
});

test("counter-example with citations yields refuted + revise_hypothesis", () => {
  const decision = evaluateResearchStance(
    hyp({
      arguments: [
        {
          kind: "counter_example",
          statement: "PreparedStatement binds id; injection not reachable",
          citations: [{ fact_id: "fact-2", job_id: "job-test-1" }],
        },
      ],
    }),
  );
  assert.equal(decision.stance, "refuted");
  assert.equal(decision.next_action, "revise_hypothesis");
  assert.match(decision.next_action_reason, /派生|复活/);
});

test("support + refute conflict stays insufficient", () => {
  const decision = evaluateResearchStance(
    hyp({
      arguments: [
        {
          kind: "supporting",
          statement: "concat SQL path exists",
          citations: [{ fact_id: "f1" }],
        },
        {
          kind: "counter_example",
          statement: "WAF blocks quote characters",
          citations: [{ fact_id: "f2" }],
        },
      ],
    }),
  );
  assert.equal(decision.stance, "insufficient");
  assert.equal(decision.next_action, "gather_more");
});

test("duplicate input fingerprint stops re-dispatch", () => {
  const h = hyp({
    arguments: [
      {
        kind: "supporting",
        statement: "same observation again",
        citations: [{ fact_id: "f1" }],
      },
    ],
  });
  const first = evaluateResearchStance(h);
  const second = evaluateResearchStance(h, {
    previousFingerprints: [h.input_fingerprint],
  });
  assert.equal(first.duplicate_plan, false);
  assert.equal(second.duplicate_plan, true);
  assert.equal(second.next_action, "stop_branch");
});

test("budget exhausted requests human without regressing pause semantics", () => {
  const decision = evaluateResearchStance(
    hyp({
      budget_remaining: 0,
      arguments: [
        {
          kind: "open_assumption",
          statement: "need device access",
          citations: [],
        },
      ],
    }),
  );
  assert.equal(decision.next_action, "request_human");
  assert.match(decision.next_action_reason, /#575|paused_reason|人工/);
});

test("derive after refute keeps parent link and rejects identical claim revive", () => {
  const parent = hyp({
    status: "refuted",
    arguments: [
      {
        kind: "counter_example",
        statement: "not reachable",
        citations: [{ fact_id: "f2" }],
      },
    ],
  });
  const child = deriveHypothesisAfterRefute(parent, "id reaches SQL when ORM bypass flag is set", {
    newArguments: [
      {
        kind: "supporting",
        statement: "bypass flag disables binding",
        citations: [{ fact_id: "f3" }],
      },
    ],
    subject_revision: "abc123",
  });
  assert.equal(child.parent_hypothesis_id, parent.hypothesis_id);
  assert.equal(child.derived_from_refute, true);
  assert.equal(child.version, parent.version + 1);
  assert.equal(child.status, "proposed");
  assert.notEqual(child.claim, parent.claim);
  assert.throws(
    () => deriveHypothesisAfterRefute(parent, parent.claim),
    /复活|相同/,
  );
});

test("Hub projection is replayable and notes governed independence", () => {
  const decision = evaluateResearchStance(
    hyp({
      arguments: [
        {
          kind: "open_assumption",
          statement: "authz may still apply",
          citations: [],
        },
      ],
    }),
  );
  const proj = projectResearchDecisionToHub(decision);
  assert.equal(proj.stance, "insufficient");
  assert.equal(proj.next_action, "gather_more");
  assert.ok(proj.expected_new_information);
  assert.match(String(proj.independence_note), /输入投影|认知独立/);
});
