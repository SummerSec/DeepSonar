import assert from "node:assert/strict";
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

type RouteRegistration = { method: string; url: string; handler: unknown };

function withoutFastifyGeneratedHead(routes: readonly RouteRegistration[]): string[] {
  const getHandlersByUrl = new Map<string, Set<unknown>>();
  for (const route of routes) {
    if (route.method !== "GET") continue;
    const handlers = getHandlersByUrl.get(route.url) ?? new Set<unknown>();
    handlers.add(route.handler);
    getHandlersByUrl.set(route.url, handlers);
  }
  return sortedUnique(
    routes
      .filter((route) => route.method !== "HEAD" || !getHandlersByUrl.get(route.url)?.has(route.handler))
      .map((route) => `${route.method} ${route.url}`),
  );
}

async function registeredRouteSurface(): Promise<string[]> {
  const app = Fastify();
  const observed: RouteRegistration[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      observed.push({ method: String(method).toUpperCase(), url: route.url, handler: route.handler });
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
    for (const method of methods) {
      observed.push({ method: String(method).toUpperCase(), url: route.url, handler: route.handler });
    }
  });
  const getHandler = async () => ({ ok: true });
  const explicitHeadHandler = async () => ({ head: true });
  app.get("/same", { exposeHeadRoute: false }, getHandler);
  app.head("/same", explicitHeadHandler);
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

test("route surface collector does not blanket-drop explicit HEAD registrations", async () => {
  assert.deepEqual(await explicitHeadRouteSurface(), ["GET /same", "HEAD /explicit-head", "HEAD /same"]);
});

test("OpenAPI operation surface matches its characterization manifest", () => {
  assert.deepEqual(sortedUnique(OPENAPI_OPERATION_SURFACE), [...OPENAPI_OPERATION_SURFACE].sort());
  assert.deepEqual(openApiSurface(), [...OPENAPI_OPERATION_SURFACE].sort());
});
