import type { FastifyInstance } from "fastify";
import { renderMetrics } from "../../metrics.js";
import { buildOpenApiDocument, buildSchemaSummary, loadApiMarkdown } from "../../openapi.js";
import { resolveProductVersion } from "../../product-version.js";
import {
  openSandboxAllowsDispatch,
  refreshOpenSandboxServerStatus,
  type OpenSandboxServerStatus,
} from "../../opensandbox-health.js";
import { runtimeImageWarmupStatus } from "../../runtime-image-warmup.js";
import { dispatcherRuntimeStatus } from "../../startup-status.js";

async function defaultOfficialImageWarnings(): Promise<string[]> {
  try {
    const { listOfficialDefaultImageTrustWarnings, officialDefaultImageRevokedWarning } = await import("../../runtime-images.js");
    const rows = await listOfficialDefaultImageTrustWarnings();
    return [...new Set(rows.map((row) => officialDefaultImageRevokedWarning(String(row.image_key))))];
  } catch {
    return [];
  }
}

/** 运行时端点摘要：api.md 不可用时（例如容器未挂载 skills/）的 Markdown 回退。 */
function runtimeSchemaMarkdown(): string {
  const summary = buildSchemaSummary() as {
    title: string;
    endpoints: { method: string; path: string; summary: string; scope: string }[];
  };
  return [
    `# ${summary.title}`,
    "",
    "（未找到 skills/.../api.md，以下为运行时生成的端点摘要，与 `GET /openapi.json` 同源）",
    "",
    ...summary.endpoints.map((endpoint) => `- \`${endpoint.method} ${endpoint.path}\` — ${endpoint.summary} _(scope: ${endpoint.scope})_`),
    "",
  ].join("\n");
}

export function registerSystemRoutes(
  app: FastifyInstance,
  dependencies: {
    runtimeImageStatus?: typeof runtimeImageWarmupStatus;
    dispatcherStatus?: typeof dispatcherRuntimeStatus;
    officialImageWarnings?: () => Promise<string[]> | string[];
    openSandboxStatus?: () => Promise<OpenSandboxServerStatus> | OpenSandboxServerStatus;
  } = {},
): void {
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
      return reply.type("text/markdown; charset=utf-8").send(runtimeSchemaMarkdown());
    }
    return reply.type("application/json; charset=utf-8").send(buildOpenApiDocument());
  });

  app.get("/schema.md", async (_req, reply) => {
    const md = loadApiMarkdown();
    if (md) return reply.type("text/markdown; charset=utf-8").send(md);
    // 不再 404 占位：回退到运行时端点清单，避免第三份契约静默分叉（#492）。
    return reply.type("text/markdown; charset=utf-8").send(runtimeSchemaMarkdown());
  });

  // Liveness stays HTTP 200 while startup images are preparing or retrying.
  app.get("/health", async () => {
    const runtimeImages = (dependencies.runtimeImageStatus ?? runtimeImageWarmupStatus)();
    const dispatcher = (dependencies.dispatcherStatus ?? dispatcherRuntimeStatus)();
    const officialTrustWarnings = await Promise.resolve(
      (dependencies.officialImageWarnings ?? defaultOfficialImageWarnings)(),
    );
    if (officialTrustWarnings.length > 0) {
      console.warn(`[health] ${officialTrustWarnings.join("; ")}`);
    }
    const openSandbox = await Promise.resolve(
      (dependencies.openSandboxStatus ?? refreshOpenSandboxServerStatus)(),
    );
    return {
      ok: true,
      ready: runtimeImages.ready && dispatcher.enabled && openSandboxAllowsDispatch(openSandbox),
      version: resolveProductVersion(),
      runtime_images: {
        ...runtimeImages,
        official_trust_warnings: officialTrustWarnings,
      },
      dispatcher,
      opensandbox: {
        level: openSandbox.level,
        domain: openSandbox.domain,
        ready: openSandboxAllowsDispatch(openSandbox),
      },
      ts: Date.now(),
    };
  });
}
