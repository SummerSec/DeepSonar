import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import test from "node:test";
import { registerRoutes } from "./routes.js";
import { buildOpenApiDocument } from "./openapi.js";
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
    "registerJobControlRoutes",
    "registerFindingVerificationRoutes",
    "registerRoleConfigRoutes",
    "registerCredentialRoutes",
    "registerRuntimeImageRoutes",
    "registerTransferRoutes",
    "registerAuthRoutes",
    "registerAuditRoutes",
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
