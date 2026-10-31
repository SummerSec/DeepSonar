import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import test from "node:test";
import { registerRoutes } from "./routes.js";
import { buildOpenApiDocument } from "./openapi.js";
import { requiredScopeForRoute } from "./auth.js";
import {
  OPENAPI_OPERATION_SURFACE,
  REGISTERED_ROUTE_SURFACE,
} from "./route-surface.manifest.js";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

type RouteRegistration = {
  method: string;
  url: string;
  handler: unknown;
  explicitHead: boolean;
  exposeHeadRoute?: boolean;
};

function withoutFastifyGeneratedHead(routes: readonly RouteRegistration[]): string[] {
  const generatedHeadBudget = new Map<string, Map<unknown, number>>();
  const consumedGeneratedHeads = new Map<string, Map<unknown, number>>();
  for (const route of routes) {
    if (route.method !== "GET" || route.exposeHeadRoute === false) continue;
    const handlers = generatedHeadBudget.get(route.url) ?? new Map<unknown, number>();
    handlers.set(route.handler, (handlers.get(route.handler) ?? 0) + 1);
    generatedHeadBudget.set(route.url, handlers);
  }
  return sortedUnique(
    routes
      .filter((route) => {
        if (route.method !== "HEAD" || route.explicitHead) return true;
        const budget = generatedHeadBudget.get(route.url)?.get(route.handler) ?? 0;
        const consumedHandlers = consumedGeneratedHeads.get(route.url) ?? new Map<unknown, number>();
        const consumed = consumedHandlers.get(route.handler) ?? 0;
        if (consumed < budget) {
          consumedHandlers.set(route.handler, consumed + 1);
          consumedGeneratedHeads.set(route.url, consumedHandlers);
          return false;
        }
        return true;
      })
      .map((route) => `${route.method} ${route.url}`),
  );
}

async function registeredRouteSurface(): Promise<string[]> {
  const app = Fastify();
  const observed: RouteRegistration[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const explicitHead = Array.isArray(route.method) && methods.some((method) => String(method).toUpperCase() === "HEAD");
    for (const method of methods) {
      observed.push({
        method: String(method).toUpperCase(),
        url: route.url,
        handler: route.handler,
        explicitHead,
        exposeHeadRoute: route.exposeHeadRoute,
      });
    }
  });
  await app.register(websocket);
  registerRoutes(app);
  await app.ready();
  await app.close();
  return withoutFastifyGeneratedHead(observed);
}

async function explicitHeadRouteSurface(): Promise<string[]> {
  const app = Fastify();
  const observed: RouteRegistration[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const explicitHead = Array.isArray(route.method) && methods.some((method) => String(method).toUpperCase() === "HEAD");
    for (const method of methods) {
      observed.push({
        method: String(method).toUpperCase(),
        url: route.url,
        handler: route.handler,
        explicitHead,
        exposeHeadRoute: route.exposeHeadRoute,
      });
    }
  });
  const getHandler = async () => ({ ok: true });
  app.get("/same", getHandler);
  app.get("/shared", { exposeHeadRoute: false }, getHandler);
  app.head("/shared", getHandler);
  app.route({ method: ["GET", "HEAD"], url: "/array", handler: getHandler });
  app.head("/explicit-head", async () => ({ ok: true }));
  await app.ready();
  await app.close();
  return withoutFastifyGeneratedHead(observed);
}

function openApiSurface(): string[] {
  const document = buildOpenApiDocument() as {
    paths: Record<string, Record<string, unknown>>;
  };
  const operations: string[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const method of Object.keys(methods)) {
      operations.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return sortedUnique(operations);
}

test("registered Fastify route surface matches the Issue #37 characterization manifest", async () => {
  assert.deepEqual(sortedUnique(REGISTERED_ROUTE_SURFACE), [...REGISTERED_ROUTE_SURFACE].sort());
  assert.deepEqual(await registeredRouteSurface(), [...REGISTERED_ROUTE_SURFACE].sort());
});

test("top-level routes module remains a hook and registrar composition root", () => {
  const source = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.ok(source.split(/\r?\n/).length <= 220, "top-level routes.ts must stay narrow");
  assert.doesNotMatch(source, /\bapp\.(?:delete|get|head|options|patch|post|put|route)\s*\(/);
  for (const registrar of [
    "registerProjectTaskRoutes",
    "registerDashboardRoutes",
    "registerJobControlRoutes",
    "registerFindingVerificationRoutes",
    "registerRoleConfigRoutes",
    "registerCredentialRoutes",
    "registerRuntimeImageRoutes",
    "registerTransferRoutes",
    "registerAuthRoutes",
    "registerAuditRoutes",
    "registerPlatformControlRoutes",
    "registerWorkerNodeRoutes",
  ]) {
    assert.match(source, new RegExp(`${registrar}\\(app\\)`), `${registrar} must be composed at the top level`);
  }
});

test("route surface collector does not blanket-drop explicit HEAD registrations", async () => {
  assert.deepEqual(await explicitHeadRouteSurface(), [
    "GET /array",
    "GET /same",
    "GET /shared",
    "HEAD /array",
    "HEAD /explicit-head",
    "HEAD /shared",
  ]);
});

test("OpenAPI operation surface matches its characterization manifest", () => {
  assert.deepEqual(sortedUnique(OPENAPI_OPERATION_SURFACE), [...OPENAPI_OPERATION_SURFACE].sort());
  assert.deepEqual(openApiSurface(), [...OPENAPI_OPERATION_SURFACE].sort());
});

/**
 * 已注册路由中不属于管理面 HTTP 契约的三组端点（#492）。它们各自用独立短期 token 或
 * 一次性 ticket 自鉴权，没有 request/response JSON 契约，因此不进 OpenAPI；
 * skills/deepsonar-management/references/api.md 已标注这点。
 */
const INTERNAL_ROUTE_ALLOWLIST = new Set([
  // Job capability Control API：沙箱内 Agent 用短期 Job capability token 调用。
  "GET /control/v1/jobs/{jobId}/capabilities",
  "GET /control/v1/jobs/{jobId}/agent/capabilities_list",
  "GET /control/v1/jobs/{jobId}/openapi.json",
  "GET /control/v1/jobs/{jobId}/operations/{operationId}",
  "POST /control/v1/jobs/{jobId}/operations/{operationId}",
  // Model Gateway 代理：Job token 自鉴权，不是管理面。
  "DELETE /gateway/*",
  "GET /gateway/*",
  "PATCH /gateway/*",
  "POST /gateway/*",
  "PUT /gateway/*",
  // 浏览器 WebSocket 升级入口：handler 内消费 POST /auth/ws-ticket 的一次性 ticket。
  "GET /ws",
  "GET /terminal-ws",
]);

/** Fastify 的 `:id([0-9a-f-]{36})` 与 OpenAPI 的 `{id}` 是同一路由。 */
function normalizeRoute(entry: string): string {
  return entry.replace(/:([A-Za-z0-9_]+)(?:\([^)]*\))?/g, "{$1}");
}

test("every registered management route is documented in OpenAPI (#492)", () => {
  const documented = new Set(openApiSurface());
  const undocumented = sortedUnique(REGISTERED_ROUTE_SURFACE.map(normalizeRoute))
    .filter((route) => !documented.has(route) && !INTERNAL_ROUTE_ALLOWLIST.has(route));
  assert.deepEqual(undocumented, [], "registered routes must be documented or explicitly internal");
  for (const route of INTERNAL_ROUTE_ALLOWLIST) {
    assert.equal(documented.has(route), false, `${route} is allowlisted as internal but now documented`);
  }
});

/**
 * OpenAPI 里无法用单一 scope 表达的两处例外（#492）：
 * - `/reports/{id}/markdown` 的 scope 在 authHook 里按报告归属解析为 tasks:read 或 findings:read；
 * - 其余所有已登记路由都必须与 requiredScopeForRoute 一致（null 记为 authenticated）。
 */
const DOCUMENTED_SCOPE_EXCEPTIONS: Record<string, string> = {
  "GET /reports/{id}/markdown": "tasks:read | findings:read",
};

test("OpenAPI operations map to registered routes and the enforced scope (#492)", () => {
  const registered = new Set(sortedUnique(REGISTERED_ROUTE_SURFACE.map(normalizeRoute)));
  const document = buildOpenApiDocument() as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const mismatches: string[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const upper = method.toUpperCase();
      const key = `${upper} ${path}`;
      if (!registered.has(key)) mismatches.push(`${key}: not a registered route`);
      const documentedScope = operation["x-deepsonar-scope"];
      // 豁免端点（/health、/auth/login、/workers/register 等）由 authHook 白名单放行，不走 scope 表。
      if (documentedScope === "exempt") continue;
      if (DOCUMENTED_SCOPE_EXCEPTIONS[key]) {
        assert.equal(documentedScope, DOCUMENTED_SCOPE_EXCEPTIONS[key], `${key} exception scope drifted`);
        continue;
      }
      // requiredScopeForRoute 返回 null = 只需要已认证主体（authHook 仍强制 Token）。
      const enforced = requiredScopeForRoute(upper, path.replace(/\{(\w+)\}/g, ":$1")) ?? "authenticated";
      if (documentedScope !== enforced) {
        mismatches.push(`${key}: documents scope ${String(documentedScope)} but enforces ${String(enforced)}`);
      }
    }
  }
  assert.deepEqual(mismatches, []);
});
