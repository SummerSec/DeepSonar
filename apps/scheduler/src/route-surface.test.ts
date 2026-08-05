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

async function registeredRouteSurface(): Promise<string[]> {
  const app = Fastify();
  const observed: string[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // Fastify synthesizes HEAD for every GET route.  The manifest records
      // explicit registrar declarations only, matching the public API/OpenAPI
      // contract rather than framework-generated aliases.
      if (String(method).toUpperCase() !== "HEAD") observed.push(`${String(method).toUpperCase()} ${route.url}`);
    }
  });
  await app.register(websocket);
  registerRoutes(app);
  await app.ready();
  await app.close();
  return sortedUnique(observed);
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

test("OpenAPI operation surface matches its characterization manifest", () => {
  assert.deepEqual(sortedUnique(OPENAPI_OPERATION_SURFACE), [...OPENAPI_OPERATION_SURFACE].sort());
  assert.deepEqual(openApiSurface(), [...OPENAPI_OPERATION_SURFACE].sort());
});
