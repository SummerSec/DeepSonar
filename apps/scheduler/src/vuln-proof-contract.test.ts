import assert from "node:assert/strict";
import test from "node:test";
import {
  VULN_PROOF_PROFILE,
  VULN_PROOF_STRATEGY_ID,
  VULN_PROOF_STRATEGY_VERSION,
  evaluateVulnProofContract,
  extractVulnProofClaimFromRows,
  frozenVulnProofStrategyMeta,
  isWeakSignalOnly,
  mergeStrategyWithVulnProof,
  parseVulnProofClaim,
  type VulnProofClaim,
} from "./vuln-proof-contract.js";
import { evaluateVerificationStrategy } from "./verify-fact-gate.js";
import {
  evaluateEvidenceIntegrityForConfirm,
  mergeStrategyWithEvidenceIntegrity,
  type FactNodeSnapshot,
} from "./verify-evidence-chain.js";

function baseClaim(over: Partial<VulnProofClaim> = {}): VulnProofClaim {
  return {
    profile: VULN_PROOF_PROFILE,
    proof_path: "static",
    subject_revision: "abc123",
    affected_component: "apps/api/auth.ts",
    attacker_control_points: ["HTTP query param id"],
    preconditions: ["authenticated low-privilege user"],
    reachability_path:
      "HTTP /api/user → AuthController.get → UserRepo.findRawSql(id) without binding",
    reachability: "reachable",
    protection_status: "none",
    impact: {
      status: "demonstrated",
      description: "Attacker reads arbitrary user rows via SQLi on id parameter",
      privilege_boundary: "same DB role as app",
    },
    static_locations: [
      {
        path: "apps/api/auth.ts",
        start_line: 40,
        end_line: 48,
        snippet_digest: "sha256:deadbeefcafebabe0123456789abcdef",
      },
    ],
    path_rationale:
      "User-controlled id flows into string-concatenated SQL with no sanitizer on path",
    tool_status: "available",
    ...over,
  };
}

test("frozen strategy meta is auditable for security.vulnerability", () => {
  const meta = frozenVulnProofStrategyMeta();
  assert.equal(meta.strategy_id, VULN_PROOF_STRATEGY_ID);
  assert.equal(meta.strategy_version, VULN_PROOF_STRATEGY_VERSION);
  assert.equal(meta.profile, VULN_PROOF_PROFILE);
  assert.deepEqual(meta.allowed_proof_paths, ["static", "dynamic"]);
});

test("TODO / dangerous function / line-hit alone cannot satisfy", () => {
  const todoOnly = baseClaim({
    weak_signals: ["todo_or_fixme_comment"],
    reachability_path: "TODO fix later",
    path_rationale: null,
    static_locations: [{ path: "x.ts", start_line: 1, snippet_digest: null }],
    impact: { status: "assumed", description: "maybe bad" },
  });
  assert.equal(isWeakSignalOnly(todoOnly), true);
  const decision = evaluateVulnProofContract(todoOnly);
  assert.equal(decision.ok, false);
  assert.equal(decision.result, "rejected");
  assert.ok(decision.required_missing.includes("weak_signal_only"));

  const fnOnly = baseClaim({
    weak_signals: ["dangerous_function_presence"],
    reachability_path: "eval exists",
    path_rationale: null,
    static_locations: [{ path: "x.ts", snippet_digest: null }],
    impact: { status: "unproven", description: "eval found" },
  });
  assert.equal(evaluateVulnProofContract(fnOnly).ok, false);

  const lineOnly = baseClaim({
    weak_signals: ["line_hit_only"],
    reachability_path: "line 12",
    path_rationale: null,
    static_locations: [{ path: "x.ts", start_line: 12, snippet_digest: null }],
    impact: { status: "assumed", description: "hit" },
  });
  assert.equal(evaluateVulnProofContract(lineOnly).ok, false);
});

test("paired sample: reachable passes, unreachable rejected", () => {
  assert.equal(evaluateVulnProofContract(baseClaim({ reachability: "reachable" })).ok, true);
  const unreachable = evaluateVulnProofContract(baseClaim({ reachability: "unreachable" }));
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.result, "rejected");
  assert.ok(unreachable.required_missing.includes("unreachable"));
});

test("paired sample: protected without bypass fails; bypassable passes", () => {
  const protectedNoBypass = evaluateVulnProofContract(
    baseClaim({
      protection_status: "present",
      protection_bypass: null,
      protections: ["authz check on user id"],
    }),
  );
  assert.equal(protectedNoBypass.ok, false);
  assert.ok(protectedNoBypass.required_missing.includes("protection_bypass"));

  const bypassable = evaluateVulnProofContract(
    baseClaim({
      protection_status: "bypassable",
      protection_bypass: "IDOR: check compares session.userId to path id with == coerced",
      protections: ["authz check on user id"],
    }),
  );
  assert.equal(bypassable.ok, true);
});

test("paired sample: demonstrated impact passes; assumed impact fails", () => {
  assert.equal(
    evaluateVulnProofContract(
      baseClaim({
        impact: {
          status: "demonstrated",
          description: "Confirmed row disclosure of other tenants via crafted id",
        },
      }),
    ).ok,
    true,
  );
  const assumed = evaluateVulnProofContract(
    baseClaim({
      impact: { status: "assumed", description: "Might leak data if reachable" },
    }),
  );
  assert.equal(assumed.ok, false);
  assert.ok(assumed.required_missing.includes("impact_not_demonstrated"));
});

test("static-ok type is not blocked by mandatory dynamic PoC", () => {
  const staticOk = evaluateVulnProofContract(
    baseClaim({ proof_path: "static", dynamic_required: false }),
  );
  assert.equal(staticOk.ok, true);
  assert.equal(staticOk.proof_path, "static");
});

test("dynamic-required type cannot pass with static narrative alone", () => {
  const blocked = evaluateVulnProofContract(
    baseClaim({ proof_path: "static", dynamic_required: true }),
  );
  assert.equal(blocked.ok, false);
  assert.ok(blocked.required_missing.includes("dynamic_proof_required"));
});

test("dynamic path requires runtime proof; text expected/actual insufficient", () => {
  const textOnly = evaluateVulnProofContract(
    baseClaim({
      proof_path: "dynamic",
      dynamic_required: true,
      runtime: {
        subject_revision: "abc123",
        expected: "deny",
        actual: "allow",
      },
    }),
  );
  assert.equal(textOnly.ok, false);
  assert.ok(textOnly.required_missing.includes("runtime_proof"));

  const withRuntime = evaluateVulnProofContract(
    baseClaim({
      proof_path: "dynamic",
      dynamic_required: true,
      runtime: {
        subject_revision: "abc123",
        steps: ["start target@abc123", "curl inject payload", "observe row leak"],
        environment: "kali-minimal@sha256:abc",
        runtime_digest: "sha256:runtime1",
        exit_code: 0,
        artifact_refs: [{ uri: "artifact://poc.log", sha256: "sha256:log1" }],
      },
    }),
  );
  assert.equal(withRuntime.ok, true);
  assert.equal(withRuntime.proof_path, "dynamic");
});

test("tool / target / device missing → inconclusive", () => {
  const tool = evaluateVulnProofContract(
    baseClaim({ tool_status: "missing", missing_tools: ["jdk17"] }),
  );
  assert.equal(tool.result, "inconclusive");
  assert.ok(tool.required_missing.includes("tool_missing"));

  const target = evaluateVulnProofContract(baseClaim({ missing_target: true }));
  assert.equal(target.result, "inconclusive");
  assert.ok(target.required_missing.includes("target_missing"));

  const device = evaluateVulnProofContract(baseClaim({ missing_device: true }));
  assert.equal(device.result, "inconclusive");
  assert.ok(device.required_missing.includes("device_missing"));
});

test("parse + extract claim from Fact row body", () => {
  const raw = baseClaim();
  const parsed = parseVulnProofClaim(raw);
  assert.ok(parsed);
  assert.equal(parsed?.proof_path, "static");

  const fromRow = extractVulnProofClaimFromRows([
    { body_json: { verification: { vuln_proof: raw } } },
  ]);
  assert.ok(fromRow);
  assert.equal(fromRow?.affected_component, "apps/api/auth.ts");
});

test("joint: fact_first + integrity + vuln proof", () => {
  const FINDING = "11111111-1111-4111-8111-111111111111";
  const strategy = evaluateVerificationStrategy(
    [
      {
        node_id: "fact-1",
        finding_id: FINDING,
        job_id: "job-1",
        job_type: "review",
        job_status: "succeeded",
        source_job_id: "job-1",
        source_role: "review",
        outcome: "supports",
        subject_revision: "abc123",
        expected: "deny",
        actual: "allow",
      },
    ],
    { findingId: FINDING, subjectRevision: "abc123" },
  );
  assert.equal(strategy.ok, true);

  const factSnap: FactNodeSnapshot = {
    node_id: "fact-1",
    finding_id: FINDING,
    job_id: "job-1",
    job_status: "succeeded",
    source_job_id: "job-1",
    source_role: "review",
    outcome: "supports",
    subject_revision: "abc123",
    expected: "deny",
    actual: "allow",
  };
  const integrity = evaluateEvidenceIntegrityForConfirm([factSnap], {
    requireRuntimeProof: false,
  });
  assert.equal(integrity.ok, true);

  let merged = mergeStrategyWithEvidenceIntegrity(strategy, integrity);
  merged = mergeStrategyWithVulnProof(merged, evaluateVulnProofContract(baseClaim()));
  assert.equal(merged.ok, true);

  const blocked = mergeStrategyWithVulnProof(
    strategy,
    evaluateVulnProofContract(
      baseClaim({
        weak_signals: ["line_hit_only"],
        reachability_path: "L1",
        path_rationale: null,
        static_locations: [{ path: "a.ts" }],
        impact: { status: "assumed", description: "x" },
      }),
    ),
  );
  assert.equal(blocked.ok, false);
  assert.ok(blocked.required_missing.includes("weak_signal_only"));
  assert.equal(blocked.confirm_reason, null);
});

test("opt-in: missing claim fails only when required", () => {
  assert.equal(evaluateVulnProofContract(null, { requireClaim: false }).ok, true);
  const required = evaluateVulnProofContract(null, { requireClaim: true });
  assert.equal(required.ok, false);
  assert.ok(required.required_missing.includes("vuln_proof_claim"));
});
