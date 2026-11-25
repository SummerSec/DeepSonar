import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "../../test-project-teardown.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("project findings summary / disposition (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("project risk summary rolls up every canvas and human_reproducing stays a disposition", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("../../db.js"),
      import("../../routes.js"),
    ]);
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const canvasA = randomUUID();
    const canvasB = randomUUID();
    const jobA = randomUUID();
    const jobB = randomUUID();
    const findingA = randomUUID();
    const findingB = randomUUID();
    const emptyProjectId = randomUUID();
    try {
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'multi-task risk')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES
        (${canvasA}, ${projectId}, '任务 A'),
        (${canvasB}, ${projectId}, '任务 B')`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES
          (${jobA}, ${projectId}, ${canvasA}, 'audit', 'succeeded', ${sql.json({})}),
          (${jobB}, ${projectId}, ${canvasB}, 'audit', 'succeeded', ${sql.json({})})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status, disposition)
        VALUES
          (${findingA}, ${projectId}, ${jobA}, ${`fp-a-${findingA}`}, 'A finding', 'high', 'pending', 'open'),
          (${findingB}, ${projectId}, ${jobB}, ${`fp-b-${findingB}`}, 'B finding', 'medium', 'pending', 'accepted')`;

      const list = await app.inject({ method: "GET", url: `/findings?project_id=${projectId}` });
      assert.equal(list.statusCode, 200, list.payload);
      const listed = JSON.parse(list.payload) as Array<{ id: string; canvas_id: string }>;
      assert.equal(listed.length, 2);
      assert.deepEqual(new Set(listed.map((row) => row.canvas_id)), new Set([canvasA, canvasB]));

      const summaryRes = await app.inject({ method: "GET", url: `/projects/${projectId}/findings/summary` });
      assert.equal(summaryRes.statusCode, 200, summaryRes.payload);
      const summary = JSON.parse(summaryRes.payload) as {
        total: number;
        project_total: number;
        truncated: boolean;
        severity: Array<{ key: string; count: number }>;
        disposition: Array<{ key: string; count: number }>;
        canvases: Array<{ id: string; count: number }>;
      };
      assert.equal(summary.total, 2);
      assert.equal(summary.project_total, 2);
      assert.equal(summary.truncated, false);
      assert.equal(summary.severity.find((item) => item.key === "high")?.count, 1);
      assert.equal(summary.canvases.find((item) => item.id === canvasB)?.count, 1);

      const canvasSummary = await app.inject({
        method: "GET",
        url: `/projects/${projectId}/findings/summary?canvas_id=${canvasA}`,
      });
      assert.equal(JSON.parse(canvasSummary.payload).total, 1);

      await sql`INSERT INTO projects (id, name) VALUES (${emptyProjectId}, 'empty risk')`;
      const emptySummary = await app.inject({ method: "GET", url: `/projects/${emptyProjectId}/findings/summary` });
      assert.equal(emptySummary.statusCode, 200);
      assert.equal(JSON.parse(emptySummary.payload).total, 0);

      const reproduce = await app.inject({
        method: "PATCH",
        url: `/findings/${findingA}/disposition`,
        payload: { disposition: "human_reproducing", note: "手工打 PoC" },
      });
      assert.equal(reproduce.statusCode, 200, reproduce.payload);
      assert.equal(JSON.parse(reproduce.payload).disposition, "human_reproducing");

      // #1264：人工确认不需要平台技术验证先通过，也不能改写 verify_status。
      const unownedEvidence = await app.inject({
        method: "PATCH",
        url: `/findings/${findingA}/disposition`,
        payload: { disposition: "confirmed_vuln", evidence_refs: ["11111111-1111-4111-8111-111111111111"] },
      });
      assert.equal(unownedEvidence.statusCode, 400, unownedEvidence.payload);
      assert.equal(JSON.parse(unownedEvidence.payload).error_code, "EVIDENCE_REF_NOT_FOUND");

      const humanConfirm = await app.inject({
        method: "PATCH",
        url: `/findings/${findingA}/disposition`,
        payload: { disposition: "confirmed_vuln", note: "人工在平台外复现成功" },
      });
      assert.equal(humanConfirm.statusCode, 200, humanConfirm.payload);
      const confirmed = JSON.parse(humanConfirm.payload);
      assert.equal(confirmed.disposition, "confirmed_vuln");
      assert.equal(confirmed.verify_status, "pending", "人工确认不得改写系统技术验证状态");
      assert.ok(typeof confirmed.disposition_by === "string" && confirmed.disposition_by.length > 0);
      assert.ok(confirmed.disposition_at);

      const after = await app.inject({ method: "GET", url: `/projects/${projectId}/findings/summary` });
      assert.equal(JSON.parse(after.payload).disposition.find((item: { key: string; count: number }) => item.key === "confirmed_vuln")?.count, 1);

      // #1264 评审：证据引用只追加，两笔并发追加都必须留在同一行。
      const evidenceIds = await Promise.all([1, 2].map(async (n) => {
        const [artifact] = await sql`
          INSERT INTO artifacts (project_id, job_id, artifact_key, kind, source_operation, source_event_id)
          VALUES (${projectId}, ${jobA}, ${`human-confirm-${n}`}, 'fact', 'emit_fact', ${`human-confirm-ev-${n}`})
          RETURNING id`;
        const [evidence] = await sql`
          INSERT INTO artifact_evidence (artifact_id, statement, kind)
          VALUES (${artifact.id}, ${`人工复现证据 ${n}`}, 'observation') RETURNING id`;
        return String(evidence.id);
      }));
      const patchEvidence = (ref: string) => app.inject({
        method: "PATCH",
        url: `/findings/${findingA}/disposition`,
        payload: { disposition: "confirmed_vuln", note: "并发追加证据", evidence_refs: [ref] },
      });
      const [first, second] = await Promise.all([patchEvidence(evidenceIds[0]!), patchEvidence(evidenceIds[1]!)]);
      assert.equal(first.statusCode, 200, first.payload);
      assert.equal(second.statusCode, 200, second.payload);
      const [mergedRow] = await sql`SELECT evidence_refs_json FROM findings WHERE id = ${findingA}`;
      assert.deepEqual(
        [...((mergedRow.evidence_refs_json as string[] | null) ?? [])].sort(),
        [...evidenceIds].sort(),
        "两笔并发追加的证据都必须保留",
      );
      // 不附证据的普通处置不改写这一列。
      const plainDisposition = await app.inject({
        method: "PATCH",
        url: `/findings/${findingA}/disposition`,
        payload: { disposition: "accepted" },
      });
      assert.equal(plainDisposition.statusCode, 200, plainDisposition.payload);
      const [keptRow] = await sql`SELECT evidence_refs_json FROM findings WHERE id = ${findingA}`;
      assert.deepEqual(
        [...((keptRow.evidence_refs_json as string[] | null) ?? [])].sort(),
        [...evidenceIds].sort(),
        "没有附证据时不得重写证据列",
      );

      // More than the former 500-row window; tie timestamps exercise UUID ordering.
      await sql`
        INSERT INTO findings (project_id, job_id, fingerprint, title, severity, verify_status, disposition, created_at)
        SELECT ${projectId}::uuid, ${jobA}::uuid, 'paged-' || n, '历史漏洞 ' || n,
          CASE WHEN n % 2 = 0 THEN 'high' ELSE 'low' END, 'pending', 'open', '2020-01-01T00:00:00.123456Z'::timestamptz
        FROM generate_series(1, 620) AS n`;
      const ids = new Set<string>();
      let cursor = "";
      do {
        const res = await app.inject({ method: "GET", url: `/findings?project_id=${projectId}&limit=50&cursor=${cursor}` });
        assert.equal(res.statusCode, 200, res.payload);
        const page = res.json();
        for (const row of page.items) { assert.ok(!ids.has(row.id)); ids.add(row.id); }
        cursor = page.next_cursor ?? "";
      } while (cursor);
      assert.equal(ids.size, 622);
      const query = new URLSearchParams({ canvas_id: `${canvasA},${canvasB}`, severity: "high,low", verify_status: "pending", disposition: "open", q: "历史漏洞 620", limit: "50" });
      const searched = await app.inject({ method: "GET", url: `/findings?project_id=${projectId}&${query}` });
      assert.equal(searched.statusCode, 200, searched.payload);
      assert.equal(searched.json().items.length, 1);
      const counted = await app.inject({ method: "GET", url: `/projects/${projectId}/findings/summary?${query}` });
      assert.equal(counted.statusCode, 200, counted.payload);
      assert.equal(counted.json().total, 1);
      assert.equal(counted.json().project_total, 622);
      const wildcard = await app.inject({ method: "GET", url: `/findings?project_id=${projectId}&q=%25&limit=50` });
      assert.equal(wildcard.json().items.length, 0);
      const invalid = await app.inject({ method: "GET", url: `/findings?project_id=${projectId}&canvas_id=${canvasA},bad&limit=50` });
      assert.equal(invalid.statusCode, 400);
      // Read semantics must also handle legacy empty severities. Loosen only this
      // test constraint while seeding that otherwise-unwritable historical shape.
      const severityFixture = `unrated-${randomUUID()}`;
      await sql`ALTER TABLE findings DROP CONSTRAINT findings_severity_check`;
      try {
        await sql`INSERT INTO findings(project_id,job_id,fingerprint,title,severity)
          SELECT ${projectId}::uuid,${jobA}::uuid,${severityFixture} || n,'unrated-fixture ' || n,
            CASE WHEN n<=65 THEN NULL WHEN n<=72 THEN '' ELSE 'high' END
          FROM generate_series(1,75) n`;
        for (const [severity, expected] of [["unset",72],["unset,high",75]] as const) {
          const seen = new Set<string>();
          let after = "";
          do {
            const filter = new URLSearchParams({ project_id:projectId,severity,q:"unrated-fixture",limit:"25",cursor:after });
            const response = await app.inject({method:"GET",url:`/findings?${filter}`});
            assert.equal(response.statusCode,200,response.payload);
            const result=response.json();
            for(const row of result.items) {
              assert.ok(!seen.has(row.id)); seen.add(row.id);
              assert.ok(row.severity===null || row.severity==="" || (severity.includes("high") && row.severity==="high"));
            }
            after=result.next_cursor ?? "";
          } while(after);
          assert.equal(seen.size,expected);
          const response=await app.inject({method:"GET",url:`/projects/${projectId}/findings/summary?${new URLSearchParams({severity,q:"unrated-fixture"})}`});
          assert.equal(response.statusCode,200,response.payload);
          assert.equal(response.json().total,expected);
          assert.equal(response.json().severity.find((bucket:{key:string})=>bucket.key==="unset").count,72);
        }
        const raw = await sql`SELECT severity,count(*)::int AS n FROM findings WHERE fingerprint LIKE ${severityFixture+'%'} GROUP BY severity`;
        assert.equal(raw.find(row=>row.severity===null)?.n,65);
        assert.equal(raw.find(row=>row.severity==='')?.n,7);
      } finally {
        await sql`DELETE FROM findings WHERE fingerprint LIKE ${severityFixture+'%'}`;
        await sql`ALTER TABLE findings ADD CONSTRAINT findings_severity_check CHECK (severity IS NULL OR severity IN ('low','medium','high','critical'))`;
      }
      // Explicit credentials are checked even in optional-auth local mode.
      const { generateToken } = await import("../../auth.js");
      const token = generateToken();
      const [tokenRow] = await sql`INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('query-test', ${projectId}, ${token.prefix}, ${token.hash}, ${["findings:read"]}) RETURNING id`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      try {
        const scoped = await app.inject({ method: "GET", url: "/findings?limit=50", headers });
        assert.equal(scoped.statusCode, 200, scoped.payload);
        assert.ok(scoped.json().items.every((row: {project_id: string}) => row.project_id === projectId));
        for (const url of [`/findings?project_id=${projectId},${emptyProjectId}&limit=50`, `/projects/${emptyProjectId}/findings/summary`]) {
          const denied = await app.inject({ method: "GET", url, headers });
          assert.equal(denied.statusCode, 403, denied.payload);
        }
        await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${tokenRow.id}`;
        const revoked = await app.inject({ method: "GET", url: `/projects/${projectId}/findings/summary`, headers });
        assert.equal(revoked.statusCode, 401, revoked.payload);
      } finally {
        await sql`DELETE FROM api_tokens WHERE id = ${tokenRow.id}`;
      }

    } finally {
      // PATCH /findings/:id/disposition 会写 audit_logs(project_id)。
      // 该表 append-only（禁止 DELETE/UPDATE），因此不能先清审计再删项目。
      // 与 recovery-issue186 一样：清掉可调度行，留下被审计引用的项目壳。
      await sql`DELETE FROM findings WHERE project_id = ANY(${[projectId, emptyProjectId]}::uuid[])`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await deleteProjectsLeavingAuditShells(sql, [projectId, emptyProjectId]);
      await app.close();
      await sql.end({ timeout: 5 });
    }
  });
}
