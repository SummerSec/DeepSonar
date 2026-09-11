import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactInput,
  EmitFactDirectPayload,
  EmitFactPayload,
  FactPayload,
} from "@deepsonar/shared-types";
import {
  ARTIFACT_KIND_OBSERVATION,
  factProposalToArtifact,
  findingArtifactKey,
  findingProposalToArtifact,
} from "./model.js";

const fact = {
  title: "登录使用独立限流键",
  description: "证据：apps/api/login.ts:42 以 IP 生成键；来源：本地源码。",
};

const artifact = {
  kind: "quality.observation",
  schema_version: "1",
  artifact_key: "login-rate-limit-key",
  claims: [
    {
      statement: "登录限流键只绑定客户端 IP。",
      subject: { type: "location", location: "apps/api/login.ts:42", label: "login limiter" },
      status: "supported" as const,
      evidence_refs: ["apps/api/login.ts:42"],
    },
    {
      statement: "反向代理可能覆盖客户端 IP。",
      status: "unknown" as const,
    },
  ],
  evidence: [
    {
      kind: "observation",
      statement: "源码以 req.ip 生成限流键。",
      polarity: "supports" as const,
      uri: "apps/api/login.ts:42",
    },
    {
      kind: "hypothesis",
      statement: "未验证 X-Forwarded-For 是否覆盖。",
      polarity: "unknown" as const,
    },
  ],
  extensions: {
    "quality.observation": { subsystem: "auth" },
  },
};

test("emit_fact accepts optional Artifact input and rejects unknown fields", () => {
  assert.equal(ArtifactInput.safeParse(artifact).success, true);
  assert.equal(EmitFactPayload.safeParse({ ...fact, artifact }).success, true);
  assert.equal(EmitFactDirectPayload.safeParse({ ...fact, artifact }).success, true);
  assert.equal(FactPayload.safeParse({ ...fact, artifact }).success, true);
  assert.equal(EmitFactPayload.safeParse({ ...fact, artifact: { ...artifact, extra: true } }).success, false);
  assert.equal(ArtifactInput.safeParse({ kind: "Not A Kind" }).success, false);
  assert.equal(ArtifactInput.safeParse({ claims: [{ statement: "x", status: "confirmed" }] }).success, false);
  assert.equal(ArtifactInput.safeParse({ evidence: [{ statement: "x", polarity: "refutes" }] }).success, false);
  assert.equal(EmitFactPayload.safeParse(fact).success, true);
});

test("factProposalToArtifact keeps supporting, contradicting, and unknown evidence", () => {
  const document = factProposalToArtifact({
    ...fact,
    artifact: {
      ...artifact,
      evidence: [
        ...artifact.evidence,
        { kind: "review", statement: "代码审查未看到代理剥离。", polarity: "contradicts" },
      ],
    },
  });
  assert.equal(document.kind, "quality.observation");
  assert.equal(document.artifact_key, "login-rate-limit-key");
  assert.equal(document.claims.length, 2);
  assert.deepEqual(document.evidence.map((item) => item.polarity), ["supports", "unknown", "contradicts"]);
  assert.equal(document.extensions["quality.observation"]?.subsystem, "auth");
});

test("legacy emit_fact without artifact still synthesizes an observation Artifact", () => {
  const document = factProposalToArtifact(fact);
  assert.equal(document.kind, ARTIFACT_KIND_OBSERVATION);
  assert.equal(document.claims.length, 1);
  assert.equal(document.claims[0]?.statement, fact.description);
  assert.equal(document.claims[0]?.status, "unknown");
  assert.equal(document.body.title, fact.title);
});

test("findingProposalToArtifact is deterministic and keeps Finding as a namespaced extension", () => {
  const finding = {
    title: "重置令牌可重放",
    profile: "security.vulnerability",
    category: "security.auth",
    tags: ["auth"],
    evidence_refs: ["src/auth/reset.ts:88"],
    severity: "high" as const,
    location: "src/auth/reset.ts:88",
    summary: "成功重置后令牌未失效，可再次修改密码。",
    rule_id: "AUTH-RESET-REPLAY",
  };
  const first = findingProposalToArtifact(finding);
  const second = findingProposalToArtifact(finding);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "security.vulnerability");
  assert.equal(first.claims[0]?.subject?.location, finding.location);
  assert.equal(first.evidence[0]?.uri, "src/auth/reset.ts:88");
  assert.equal(first.extensions["security.vulnerability"]?.rule_id, "AUTH-RESET-REPLAY");
  assert.equal(findingArtifactKey("abc123"), "finding:abc123");
});
