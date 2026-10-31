import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  INVALID_ROLE_CONFIG_ID,
  INVALID_ROLE_ID,
  registerRoleConfigRoutes,
} from "./routes.js";

const INVALID_NAME = "explore";
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

async function withApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>): Promise<void> {
  const app = Fastify({ logger: false });
  registerRoleConfigRoutes(app);
  await app.ready();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

function assertClientError(
  response: { statusCode: number; payload: string },
  errorCode: string,
): void {
  assert.equal(response.statusCode, 400, response.payload);
  const body = JSON.parse(response.payload) as { error?: string; error_code?: string; message?: string };
  assert.equal(body.error_code, errorCode);
  assert.equal(typeof body.error, "string");
  assert.doesNotMatch(JSON.stringify(body), /invalid input syntax|PostgresError|22P02/i);
}

test("RoleConfig path params reject non-UUID values before SQL", async () => {
  await withApp(async (app) => {
    const cases: Array<{ method: "PUT" | "PATCH" | "DELETE" | "GET"; url: string; payload?: unknown; errorCode: string }> = [
      { method: "PUT", url: `/role-configs/global/${INVALID_NAME}`, payload: {}, errorCode: INVALID_ROLE_ID.error_code },
      { method: "PUT", url: `/projects/${VALID_UUID}/role-configs/${INVALID_NAME}`, payload: {}, errorCode: INVALID_ROLE_ID.error_code },
      { method: "PUT", url: `/projects/${INVALID_NAME}/role-configs/${VALID_UUID}`, payload: {}, errorCode: "INVALID_ID" },
      { method: "DELETE", url: `/projects/${VALID_UUID}/role-configs/${INVALID_NAME}`, errorCode: INVALID_ROLE_ID.error_code },
      { method: "DELETE", url: `/projects/${INVALID_NAME}/role-configs/${VALID_UUID}`, errorCode: "INVALID_ID" },
      { method: "PATCH", url: `/role-configs/${INVALID_NAME}/agent-cli`, payload: { agent_cli: "claude-code" }, errorCode: INVALID_ROLE_CONFIG_ID.error_code },
      { method: "PATCH", url: `/role-configs/${INVALID_NAME}/runtime-image`, payload: { runtime_image_key: null }, errorCode: INVALID_ROLE_CONFIG_ID.error_code },
      { method: "GET", url: `/projects/${INVALID_NAME}/role-configs`, errorCode: "INVALID_ID" },
      { method: "PATCH", url: `/agent-roles/${INVALID_NAME}`, payload: { title: "x" }, errorCode: INVALID_ROLE_ID.error_code },
      { method: "DELETE", url: `/agent-roles/${INVALID_NAME}`, errorCode: INVALID_ROLE_ID.error_code },
      { method: "GET", url: `/projects/${INVALID_NAME}/roles`, errorCode: "INVALID_ID" },
    ];

    for (const item of cases) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        payload: item.payload,
      });
      assertClientError(response, item.errorCode);
    }
  });
});
