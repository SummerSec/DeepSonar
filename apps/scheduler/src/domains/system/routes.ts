import type { FastifyInstance } from "fastify";
import { renderMetrics } from "../../metrics.js";
import { buildOpenApiDocument, buildSchemaSummary, loadApiMarkdown } from "../../openapi.js";

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get("/metrics", async (_req, reply) =>
    reply.type("text/plain; version=0.0.4").send(await renderMetrics()));

  app.get("/openapi.json", async (_req, reply) =>
    reply.type("application/json; charset=utf-8").send(buildOpenApiDocument()));

  app.get("/schema", async (req, reply) => {
    const format = String((req.query as { format?: string }).format ?? "openapi").toLowerCase();
    if (format === "summary") {
      return reply.type("application/json; charset=utf-8").send(buildSchemaSummary());
    }
    if (format === "markdown" || format === "md") {
      const md = loadApiMarkdown();
      if (md) return reply.type("text/markdown; charset=utf-8").send(md);
      const summary = buildSchemaSummary() as { title: string; endpoints: { method: string; path: string; summary: string; scope: string }[] };
      const lines = [
        `# ${summary.title}`,
        "",
        "（未找到 skills/.../api.md，以下为运行时生成的端点摘要）",
        "",
        ...summary.endpoints.map((endpoint) => `- \`${endpoint.method} ${endpoint.path}\` — ${endpoint.summary} _(scope: ${endpoint.scope})_`),
        "",
      ];
      return reply.type("text/markdown; charset=utf-8").send(lines.join("\n"));
    }
    return reply.type("application/json; charset=utf-8").send(buildOpenApiDocument());
  });

  app.get("/schema.md", async (_req, reply) => {
    const md = loadApiMarkdown();
    if (md) return reply.type("text/markdown; charset=utf-8").send(md);
    return reply.code(404).send({ error: "api.md not found in workspace" });
  });

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));
}
