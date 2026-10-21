import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import {
  decidePause,
  decideResume,
  PlatformClaimsPauseBody,
  PlatformClaimsResumeBody,
  platformClaimsActorLabel,
  projectPlatformClaimsStatus,
  readPlatformClaimsControlRow,
  type PlatformClaimsWorkload,
} from "./model.js";
import { registerPlatformClaimsRoutes } from "./routes.js";
import { requiredScopeForRoute } from "../../auth.js";

const idle: PlatformClaimsWorkload = {
  in_flight: { claimed: 0, provisioning: 0, running: 0, total: 0 },
  pending: 0,
  waiting_human: 0,
  effect_pending_attempts: 0,
  unknown_effect_attempts: 0,
};

test("missing or unknown pause state fails closed as paused", () => {
  assert.deepEqual(readPlatformClaimsControlRow(undefined), {
    paused: true, reason: null, note: null, paused_by: null, paused_at: null, missing: true,
  });
  assert.equal(readPlatformClaimsControlRow({ claims_paused: null }).paused, true);
  assert.equal(readPlatformClaimsControlRow({ claims_paused: false }).paused, false);
  const unknownReason = readPlatformClaimsControlRow({ claims_paused: true, claims_pause_reason: "bogus" });
  assert.equal(unknownReason.paused, true);
  assert.equal(unknownReason.reason, null);
  const at = new Date("2026-10-15T06:00:00.000Z");
  const row = readPlatformClaimsControlRow({
    claims_paused: true,
    claims_pause_reason: "platform_upgrade",
    claims_pause_note: "v0.6.0",
    claims_paused_by: "user:alice",
    claims_paused_at: at,
  });
  assert.deepEqual(row, {
    paused: true,
    reason: "platform_upgrade",
    note: "v0.6.0",
    paused_by: "user:alice",
    paused_at: at.toISOString(),
    missing: false,
  });
});

test("state projection: pausing until in-flight Jobs and all unsettled Attempt effects drain", () => {
  const paused = readPlatformClaimsControlRow({ claims_paused: true, claims_pause_reason: "maintenance", claims_paused_by: "x", claims_paused_at: "t" });
  const running = readPlatformClaimsControlRow({ claims_paused: false });
  assert.equal(projectPlatformClaimsStatus(running, idle).state, "running");
  assert.equal(projectPlatformClaimsStatus(paused, idle).state, "paused");
  assert.equal(projectPlatformClaimsStatus(paused, { ...idle, in_flight: { claimed: 0, provisioning: 1, running: 0, total: 1 } }).state, "pausing");
  assert.equal(projectPlatformClaimsStatus(paused, { ...idle, effect_pending_attempts: 1 }).state, "pausing");
  assert.equal(projectPlatformClaimsStatus(paused, { ...idle, unknown_effect_attempts: 1 }).drained, false);
  // pending and waiting_human do not block the drained state.
  const waiting = projectPlatformClaimsStatus(paused, { ...idle, pending: 5, waiting_human: 2 });
  assert.equal(waiting.state, "paused");
  assert.equal(waiting.pending, 5);
});

test("pause is idempotent per reason; resume can be scoped to the reason that paused", () => {
  const running = readPlatformClaimsControlRow({ claims_paused: false });
  const upgrade = readPlatformClaimsControlRow({ claims_paused: true, claims_pause_reason: "platform_upgrade", claims_paused_by: "x", claims_paused_at: "t" });
  assert.deepEqual(decidePause(running, "platform_upgrade"), { kind: "apply" });
  assert.deepEqual(decidePause(upgrade, "platform_upgrade"), { kind: "noop" });
  assert.deepEqual(decidePause(upgrade, "maintenance"), { kind: "conflict", current: "platform_upgrade" });
  assert.deepEqual(decideResume(running, undefined), { kind: "noop" });
  assert.deepEqual(decideResume(upgrade, undefined), { kind: "apply" });
  assert.deepEqual(decideResume(upgrade, "platform_upgrade"), { kind: "apply" });
  assert.deepEqual(decideResume(upgrade, "maintenance"), { kind: "mismatch", current: "platform_upgrade" });
});

test("request bodies are strict and bounded", () => {
  assert.equal(PlatformClaimsPauseBody.safeParse({ reason: "platform_upgrade" }).success, true);
  assert.equal(PlatformClaimsPauseBody.safeParse({ reason: "platform_upgrade", note: "x".repeat(500) }).success, true);
  assert.equal(PlatformClaimsPauseBody.safeParse({ reason: "platform_upgrade", note: "x".repeat(501) }).success, false);
  assert.equal(PlatformClaimsPauseBody.safeParse({ reason: "platform_upgrade", note: "   " }).success, false);
  assert.equal(PlatformClaimsPauseBody.safeParse({ reason: "upgrade" }).success, false);
  assert.equal(PlatformClaimsPauseBody.safeParse({ reason: "maintenance", paused_by: "spoof" }).success, false);
  assert.equal(PlatformClaimsResumeBody.safeParse({}).success, true);
  assert.equal(PlatformClaimsResumeBody.safeParse({ force: true }).success, false);
});

test("operator label is bounded and never derived from request input", () => {
  assert.equal(platformClaimsActorLabel(undefined), "internal:internal");
  assert.equal(platformClaimsActorLabel({ type: "user", id: "u1", name: "alice" }), "user:alice");
  assert.equal(platformClaimsActorLabel({ type: "api_token", id: "tok-1", name: "" }), "api_token:tok-1");
  assert.equal(platformClaimsActorLabel({ type: "user", id: null, name: "a".repeat(400) }).length, 200);
});

test("pause/resume are admin-only; status is readable for the Web banner", () => {
  assert.equal(requiredScopeForRoute("GET", "/platform/claims"), "tasks:read");
  assert.equal(requiredScopeForRoute("POST", "/platform/claims/pause"), "admin");
  assert.equal(requiredScopeForRoute("POST", "/platform/claims/resume"), "admin");
});

test("project-scoped tokens cannot read or control the platform claim gate", async () => {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    req.actor = { type: "api_token", id: "t", name: "project-token", projectId: "11111111-1111-4111-8111-111111111111", scopes: ["admin"] };
  });
  // The guard runs before any database access; a db that throws proves it.
  const db = new Proxy(() => undefined, {
    apply() { throw new Error("database must not be touched"); },
    get() { throw new Error("database must not be touched"); },
  }) as never;
  registerPlatformClaimsRoutes(app, db);
  for (const [method, url] of [["GET", "/platform/claims"], ["POST", "/platform/claims/pause"], ["POST", "/platform/claims/resume"]] as const) {
    const response = await app.inject({ method, url, payload: method === "POST" ? { reason: "maintenance" } : undefined });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.equal(response.json().error_code, "PLATFORM_CLAIMS_PROJECT_TOKEN_FORBIDDEN");
  }
  await app.close();
});

test("dispatcher reads the platform gate inside the claim advisory lock", () => {
  const source = readFileSync(new URL("../../dispatcher.ts", import.meta.url), "utf8");
  const lock = source.indexOf("await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;\n    // #740");
  const gate = source.indexOf("readPlatformClaimsControl(tx as unknown as typeof sql)");
  const firstPendingScan = source.indexOf("WHERE j.status = 'pending'");
  assert.ok(lock > 0, "claim transaction must take the dispatch advisory lock");
  assert.ok(gate > lock, "platform gate must be read after the advisory lock");
  assert.ok(gate < firstPendingScan, "platform gate must be checked before scanning pending Jobs");
  const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  assert.match(store, /pg_advisory_xact_lock\(hashtext\(\$\{DISPATCH_CLAIM_ADVISORY_KEY\}\)\)/);
});
