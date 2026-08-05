import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
type InjectResponse = { statusCode: number; payload: string; headers: Record<string, string | undefined> };

if (!testDatabaseUrl) {
  test("report download auth integration requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("report downloads enforce auth/scope/project ownership and preserve attachment bytes", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_report_download_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    const blobDir = path.resolve(process.cwd(), `data/report-download-test-${process.pid}-${Date.now()}`);
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    let sql: typeof import("./db.js").sql;
    let config: typeof import("./config.js").config;
    const ownProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const ownCanvasId = randomUUID();
    const otherCanvasId = randomUUID();
    const ownReportId = randomUUID();
    const otherReportId = randomUUID();
    const sourceJobId = randomUUID();
    const findingId = randomUUID();
    const findingReportId = randomUUID();

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.BLOB_DIR = blobDir;
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule, configModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./auth.js"),
        import("./config.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      ({ sql } = dbModule);
      config = configModule.config;
      const { migrate } = dbModule;
      const { registerRoutes } = routesModule;
      const { generateToken } = authModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      await mkdir(path.join(blobDir, "reports", ownCanvasId), { recursive: true });
      await mkdir(path.join(blobDir, "reports", otherCanvasId), { recursive: true });
      await mkdir(path.join(blobDir, "finding-reports", findingId, "v1"), { recursive: true });
      const markdown = "# own report\n\nbytes must remain markdown\n";
      const findingMarkdown = "# finding report\n\nrequires findings read scope\n";
      const sarif = '{"version":"2.1.0","runs":[]}\n';
      await writeFile(path.join(blobDir, "reports", ownCanvasId, "report.md"), markdown, "utf8");
      await writeFile(path.join(blobDir, "reports", ownCanvasId, "report.sarif.json"), sarif, "utf8");
      await writeFile(path.join(blobDir, "reports", otherCanvasId, "report.md"), "# other\n", "utf8");
      await writeFile(path.join(blobDir, "finding-reports", findingId, "v1", "report.md"), findingMarkdown, "utf8");

      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      await sql`
        INSERT INTO projects (id, canvas_id, name)
        VALUES (${ownProjectId}, ${ownCanvasId}, 'report own'), (${otherProjectId}, ${otherCanvasId}, 'report other')`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${ownCanvasId}, ${ownProjectId}, 'Own report task', ${sql.json({})}),
               (${otherCanvasId}, ${otherProjectId}, 'Other report task', ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${ownCanvasId}, 'root', 'root', 'analysis_complete', ${sql.json({})}),
               (${otherCanvasId}, 'root', 'root', 'analysis_complete', ${sql.json({})})`;
      await sql`
        INSERT INTO task_reports (id, canvas_id, project_id, status, summary_json, markdown_uri, sarif_uri)
        VALUES
          (${ownReportId}, ${ownCanvasId}, ${ownProjectId}, 'succeeded', ${sql.json({ confirmed_count: 1 })},
            ${path.posix.join("reports", ownCanvasId, "report.md")},
            ${path.posix.join("reports", ownCanvasId, "report.sarif.json")}),
          (${otherReportId}, ${otherCanvasId}, ${otherProjectId}, 'succeeded', ${sql.json({})},
            ${path.posix.join("reports", otherCanvasId, "report.md")}, NULL)`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${sourceJobId}, ${ownProjectId}, ${ownCanvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO findings (
          id, project_id, job_id, fingerprint, title, severity, verify_status, raw_json
        ) VALUES (
          ${findingId}, ${ownProjectId}, ${sourceJobId}, 'report-download-finding',
          'Finding report scope', 'high', 'confirmed', ${sql.json({})}
        )`;
      await sql`
        INSERT INTO finding_reports (
          id, finding_id, canvas_id, project_id, version, status,
          input_uri, input_sha256, summary_json, markdown_uri, markdown_sha256
        ) VALUES (
          ${findingReportId}, ${findingId}, ${ownCanvasId}, ${ownProjectId}, 1, 'succeeded',
          ${path.posix.join("finding-reports", findingId, "v1", "report-input.json")}, ${"0".repeat(64)},
          ${sql.json({})}, ${path.posix.join("finding-reports", findingId, "v1", "report.md")}, ${"0".repeat(64)}
        )`;

      const insertToken = async (name: string, scopes: string[], projectId?: string) => {
        const token = generateToken();
        await sql`
          INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
          VALUES (${name}, ${projectId ?? null}, ${token.prefix}, ${token.hash}, ${scopes})`;
        return { authorization: `Bearer ${token.plaintext}` };
      };
      const ownRead = await insertToken("report-own-read", ["tasks:read"], ownProjectId);
      const ownControl = await insertToken("report-own-control", ["tasks:read", "jobs:control"], ownProjectId);
      const ownFindingRead = await insertToken("report-own-finding-read", ["findings:read"], ownProjectId);
      const ownWrongScope = await insertToken("report-own-wrong-scope", ["projects:read"], ownProjectId);

      const inject = (method: "GET" | "POST", url: string, headers?: Record<string, string>) =>
        app.inject({ method, url, headers } as never) as unknown as Promise<InjectResponse>;

      assert.equal((await inject("GET", `/reports/${ownReportId}/markdown`)).statusCode, 401, "no token must be 401");
      assert.equal((await inject("GET", `/reports/${ownReportId}/markdown`, ownWrongScope)).statusCode, 403, "wrong scope must be 403");

      const markdownResponse = await inject("GET", `/reports/${ownReportId}/markdown`, ownRead);
      assert.equal(markdownResponse.statusCode, 200, markdownResponse.payload);
      assert.match(markdownResponse.headers["content-type"] ?? "", /^text\/markdown/);
      assert.equal(markdownResponse.headers["content-disposition"], `attachment; filename="report-${ownReportId}.md"`);
      assert.equal(markdownResponse.payload, markdown);

      assert.equal(
        (await inject("GET", `/reports/${findingReportId}/markdown`, ownRead)).statusCode,
        403,
        "tasks:read must not download a Finding report",
      );
      const findingMarkdownResponse = await inject("GET", `/reports/${findingReportId}/markdown`, ownFindingRead);
      assert.equal(findingMarkdownResponse.statusCode, 200, findingMarkdownResponse.payload);
      assert.equal(findingMarkdownResponse.payload, findingMarkdown);
      assert.equal(
        (await inject("GET", `/reports/${ownReportId}/markdown`, ownFindingRead)).statusCode,
        403,
        "findings:read must not download a task report",
      );

      const sarifResponse = await inject("GET", `/reports/${ownReportId}/sarif`, ownRead);
      assert.equal(sarifResponse.statusCode, 200, sarifResponse.payload);
      assert.match(sarifResponse.headers["content-type"] ?? "", /^application\/sarif\+json/);
      assert.equal(sarifResponse.headers["content-disposition"], `attachment; filename="report-${ownReportId}.sarif"`);
      assert.equal(sarifResponse.payload, sarif);

      const ownMetadata = await inject("GET", `/canvases/${ownCanvasId}/report`, ownRead);
      assert.equal(ownMetadata.statusCode, 200, ownMetadata.payload);
      assert.equal(JSON.parse(ownMetadata.payload).id, ownReportId);
      assert.equal((await inject("GET", `/reports/${otherReportId}/markdown`, ownRead)).statusCode, 403, "cross-project report must be denied");
      assert.equal((await inject("GET", `/canvases/${otherCanvasId}/report`, ownRead)).statusCode, 403, "canvas ownership remains enforced");

      const noAuthRetry = await inject("POST", `/canvases/${ownCanvasId}/report/retry`, ownRead);
      assert.equal(noAuthRetry.statusCode, 403, "tasks:read cannot retry");
      const controlRetry = await inject("POST", `/canvases/${ownCanvasId}/report/retry`, ownControl);
      assert.notEqual(controlRetry.statusCode, 403, controlRetry.payload);

      // Auth-off compatibility: no Bearer is accepted, while the same
      // attachment contract remains in force.
      (config.auth as { required: boolean }).required = false;
      const authOff = await inject("GET", `/reports/${ownReportId}/markdown`);
      assert.equal(authOff.statusCode, 200, authOff.payload);
      assert.equal(authOff.payload, markdown);
      (config.auth as { required: boolean }).required = true;
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      await rm(blobDir, { recursive: true, force: true }).catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
