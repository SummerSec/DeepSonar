import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "../../test-project-teardown.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Artifact write path PostgreSQL integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("emit_fact and emit_finding persist Artifact as write truth and project Finding", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { ingestEvent } = await import("../../core.js");
    const { ControlInputError } = await import("../../control-input.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `artifact-${randomUUID()}`;
    const exploreJobId = randomUUID();
    const auditJobId = randomUUID();
    const relatedArtifactId = randomUUID();

    try {
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${projectId}, 'artifact-phase1', ${sql.json({ rules: { hubEnabled: false } })})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'artifact-phase1', ${sql.json({
          effective_finding_protocol: {
            mode: "hybrid",
            default_profile: "security.vulnerability",
            allowed_profiles: ["security.vulnerability", "general"],
            scoring: {
              default_standard: "CVSS",
              default_version: "3.1",
              accepted_versions: ["3.1", "4.0"],
              require_scoring_for_profiles: [],
            },
            display_name: "artifact-phase1",
            source: "task",
          },
        })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;
      const exploreSnapshot = {
        name: "explore",
        role_kind: "role",
        platform_tools: ["emit_progress", "emit_fact", "mark_job_done"],
      };
      const auditSnapshot = {
        name: "audit",
        role_kind: "role",
        platform_tools: ["emit_progress", "emit_finding", "mark_job_done"],
      };
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES
          (${exploreJobId}, ${projectId}, ${canvasId}, 'explore', 'running', ${sql.json(exploreSnapshot)}, ${sql.json({})}),
          (${auditJobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(auditSnapshot)}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES
          (${canvasId}, ${exploreJobId}, 'intent', 'explore', 'running', ${sql.json({})}),
          (${canvasId}, ${auditJobId}, 'intent', 'audit', 'running', ${sql.json({})})`;
      await sql`
        INSERT INTO artifacts ${sql({
          id: relatedArtifactId,
          project_id: projectId,
          canvas_id: canvasId,
          job_id: exploreJobId,
          artifact_key: "seed-observation",
          revision: 1,
          kind: "observation",
          source_operation: "emit_fact",
        })}`;

      const factEventId = randomUUID();
      await ingestEvent(exploreJobId, {
        v: 1,
        event_id: factEventId,
        type: "fact",
        payload: {
          title: "限流键只绑定 IP",
          description: "源码以客户端 IP 生成限流键，反向代理覆盖仍未知。",
          artifact: {
            kind: "quality.observation",
            artifact_key: "login-rate-limit",
            claims: [
              {
                statement: "登录限流键只绑定客户端 IP。",
                subject: { type: "location", location: "apps/api/login.ts:42", label: "login limiter" },
                status: "supported",
              },
              {
                statement: "反向代理可能覆盖客户端 IP。",
                status: "unknown",
              },
            ],
            evidence: [
              {
                kind: "observation",
                statement: "源码以 req.ip 生成限流键。",
                polarity: "supports",
                uri: "apps/api/login.ts:42",
              },
              {
                kind: "hypothesis",
                statement: "未验证 X-Forwarded-For 是否覆盖。",
                polarity: "unknown",
              },
              {
                kind: "review",
                statement: "审查未见代理剥离逻辑。",
                polarity: "contradicts",
              },
            ],
            relations: [{ to_artifact_id: relatedArtifactId, relation_type: "related" }],
            extensions: { "quality.observation": { subsystem: "auth" } },
          },
        },
      });

      const [factArtifact] = await sql<{
        id: string;
        kind: string;
        artifact_key: string;
        revision: number;
        source_operation: string;
        source_event_id: string | null;
        extensions_json: { "quality.observation"?: { subsystem?: string } };
        node_id: string | null;
      }[]>`
        SELECT id, kind, artifact_key, revision, source_operation, source_event_id, extensions_json, node_id
        FROM artifacts
        WHERE project_id = ${projectId} AND artifact_key = 'login-rate-limit' AND superseded_at IS NULL`;
      assert.equal(factArtifact?.kind, "quality.observation");
      assert.equal(factArtifact?.revision, 1);
      assert.equal(factArtifact?.source_operation, "emit_fact");
      assert.equal(factArtifact?.source_event_id, factEventId);
      assert.equal(factArtifact?.extensions_json["quality.observation"]?.subsystem, "auth");
      assert.ok(factArtifact?.node_id);

      const claims = await sql<{ statement: string; status: string }[]>`
        SELECT statement, status FROM artifact_claims WHERE artifact_id = ${factArtifact.id} ORDER BY ordinal`;
      assert.equal(claims.length, 2);
      assert.deepEqual(claims.map((row) => row.status), ["supported", "unknown"]);

      const evidence = await sql<{ polarity: string }[]>`
        SELECT polarity FROM artifact_evidence WHERE artifact_id = ${factArtifact.id} ORDER BY ordinal`;
      assert.deepEqual(evidence.map((row) => row.polarity), ["supports", "unknown", "contradicts"]);

      const [relation] = await sql<{ to_artifact_id: string; relation_type: string }[]>`
        SELECT to_artifact_id, relation_type FROM artifact_relations WHERE from_artifact_id = ${factArtifact.id}`;
      assert.equal(relation?.to_artifact_id, relatedArtifactId);
      assert.equal(relation?.relation_type, "related");

      const [factNode] = await sql<{ body_json: { artifact_id?: string } }[]>`
        SELECT body_json FROM canvas_nodes WHERE id = ${factArtifact.node_id}`;
      assert.equal(factNode?.body_json.artifact_id, factArtifact.id);

      await ingestEvent(exploreJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "fact",
        payload: {
          title: "限流键修订",
          description: "补充确认 nginx 未剥离 X-Forwarded-For。",
          artifact: { artifact_key: "login-rate-limit", kind: "quality.observation" },
        },
      });
      const versions = await sql<{ revision: number; status: string }[]>`
        SELECT revision, status FROM artifacts
        WHERE project_id = ${projectId} AND artifact_key = 'login-rate-limit'
        ORDER BY revision`;
      assert.deepEqual([...versions], [
        { revision: 1, status: "superseded" },
        { revision: 2, status: "submitted" },
      ]);

      await ingestEvent(exploreJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "fact",
        payload: {
          title: "兼容事实",
          description: "没有结构化 Artifact 字段时仍应写成 observation。",
        },
      });
      const [legacy] = await sql<{ kind: string; source_operation: string }[]>`
        SELECT a.kind, a.source_operation
        FROM artifacts a
        JOIN canvas_nodes n ON n.id = a.node_id
        WHERE a.job_id = ${exploreJobId} AND n.title = '兼容事实'`;
      assert.equal(legacy?.kind, "observation");
      assert.equal(legacy?.source_operation, "emit_fact");

      const foreignArtifactId = randomUUID();
      await assert.rejects(
        ingestEvent(exploreJobId, {
          v: 1,
          event_id: randomUUID(),
          type: "fact",
          payload: {
            title: "非法关系",
            description: "指向不存在的 Artifact 必须整笔回滚。",
            artifact: {
              relations: [{ to_artifact_id: foreignArtifactId, relation_type: "related" }],
            },
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ControlInputError);
          assert.equal(error.code, "invalid_payload");
          return true;
        },
      );
      const [rolledBack] = await sql`
        SELECT 1 FROM canvas_nodes WHERE job_id = ${exploreJobId} AND title = '非法关系'`;
      assert.equal(rolledBack, undefined);

      const findingEventId = randomUUID();
      const findingPayload = {
        title: "重置令牌可重复使用",
        summary: "成功重置后令牌未失效，可再次修改密码并接管账户。此摘要补足 Finding 契约要求的证据上下文长度。",
        severity: "high" as const,
        location: "src/auth/reset.ts:88",
        rule_id: "AUTH-RESET-REPLAY",
        evidence_refs: ["src/auth/reset.ts:88"],
      };
      await ingestEvent(auditJobId, {
        v: 1,
        event_id: findingEventId,
        type: "finding",
        payload: findingPayload,
      });
      const [finding] = await sql<{
        id: string;
        artifact_id: string | null;
        title: string;
        fingerprint: string;
      }[]>`
        SELECT id, artifact_id, title, fingerprint FROM findings WHERE job_id = ${auditJobId}`;
      assert.ok(finding?.artifact_id);
      assert.equal(finding.title, findingPayload.title);

      const [findingArtifact] = await sql<{
        artifact_key: string;
        kind: string;
        source_operation: string;
        source_event_id: string | null;
      }[]>`
        SELECT artifact_key, kind, source_operation, source_event_id
        FROM artifacts WHERE id = ${finding.artifact_id}`;
      assert.equal(findingArtifact?.artifact_key, `finding:${finding.fingerprint}`);
      assert.equal(findingArtifact?.kind, "security.vulnerability");
      assert.equal(findingArtifact?.source_operation, "emit_finding");
      assert.equal(findingArtifact?.source_event_id, findingEventId);

      const [extension] = await sql<{ extensions_json: { "security.vulnerability"?: { rule_id?: string } } }[]>`
        SELECT extensions_json FROM artifacts WHERE id = ${finding.artifact_id}`;
      assert.equal(extension?.extensions_json["security.vulnerability"]?.rule_id, "AUTH-RESET-REPLAY");

      await ingestEvent(auditJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "finding",
        payload: findingPayload,
      });
      const [findingCount] = await sql<{ findings: number; artifacts: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM findings WHERE job_id = ${auditJobId}) AS findings,
          (SELECT COUNT(*)::int FROM artifacts WHERE job_id = ${auditJobId} AND source_operation = 'emit_finding') AS artifacts`;
      assert.deepEqual(findingCount, { findings: 1, artifacts: 1 });
    } finally {
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id IN (SELECT id FROM findings WHERE project_id = ${projectId})`;
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM artifacts WHERE project_id = ${projectId}`;
      await sql`DELETE FROM event_dedup WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
      await sql.end({ timeout: 5 });
    }
  });
}
