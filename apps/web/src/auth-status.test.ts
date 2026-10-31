import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AuthStatus } from "./api";
import {
  AUTH_STATUS_UNAVAILABLE,
  RAIL_AUTH_DEV_LABEL,
  RAIL_AUTH_ERROR_LABEL,
  RAIL_AUTH_LOADING_LABEL,
  isExplicitAuthDisabled,
  resolveAuthStatusReadiness,
  resolveRailAuthPresentation,
} from "./auth-status";

const required: AuthStatus = {
  auth_required: true,
  has_users: true,
  bootstrap_available: false,
  default_admin_credentials_active: false,
  session_ttl_days: 7,
};

const disabled: AuthStatus = { ...required, auth_required: false };

test("explicit auth-disabled is only true when auth_required is false", () => {
  assert.equal(isExplicitAuthDisabled(disabled), true);
  assert.equal(isExplicitAuthDisabled(required), false);
  assert.equal(isExplicitAuthDisabled(null), false);
  assert.equal(isExplicitAuthDisabled(undefined), false);
});

test("status readiness keeps loading and failure out of the ready/dev path", () => {
  assert.deepEqual(resolveAuthStatusReadiness({ loading: true, status: null }), { kind: "loading" });
  assert.deepEqual(resolveAuthStatusReadiness({ loading: true, status: required }), { kind: "loading" });
  assert.deepEqual(
    resolveAuthStatusReadiness({ loading: false, status: null }),
    { kind: "error", message: AUTH_STATUS_UNAVAILABLE },
  );
  assert.deepEqual(
    resolveAuthStatusReadiness({ loading: false, status: null, error: new Error(" /auth/status 502") }),
    { kind: "error", message: " /auth/status 502" },
  );
  assert.deepEqual(resolveAuthStatusReadiness({ loading: false, status: required }), { kind: "ready", status: required });
});

test("rail never claims 开发模式 unless auth_required is explicitly false", () => {
  const loading = resolveRailAuthPresentation({ loading: true, status: null });
  assert.deepEqual(loading, {
    kind: "loading",
    label: RAIL_AUTH_LOADING_LABEL,
    className: "is-pending",
    title: RAIL_AUTH_LOADING_LABEL,
  });
  assert.equal(loading.label.includes("开发模式"), false);

  const unknown = resolveRailAuthPresentation({ loading: false, status: null });
  assert.deepEqual(unknown, {
    kind: "error",
    label: RAIL_AUTH_ERROR_LABEL,
    className: "is-error",
    title: AUTH_STATUS_UNAVAILABLE,
  });
  assert.equal(unknown.label.includes("开发模式"), false);

  const failed = resolveRailAuthPresentation({
    loading: false,
    status: null,
    error: new Error("scheduler unreachable"),
  });
  assert.deepEqual(failed, {
    kind: "error",
    label: RAIL_AUTH_ERROR_LABEL,
    className: "is-error",
    title: "scheduler unreachable",
  });
  assert.equal(failed.label.includes("开发模式"), false);

  const production = resolveRailAuthPresentation({ loading: false, status: required });
  assert.equal(production.kind, "session");

  const dev = resolveRailAuthPresentation({ loading: false, status: disabled });
  assert.deepEqual(dev, {
    kind: "dev",
    label: RAIL_AUTH_DEV_LABEL,
    className: "is-dev",
    title: RAIL_AUTH_DEV_LABEL,
  });
});

test("AppShell and login no longer treat missing status as auth_required=false", () => {
  const shell = readFileSync(new URL("./layout/AppShell.tsx", import.meta.url), "utf8");
  const login = readFileSync(new URL("./pages/LoginPage.tsx", import.meta.url), "utf8");
  const gate = readFileSync(new URL("./auth.tsx", import.meta.url), "utf8");
  assert.match(shell, /resolveRailAuthPresentation/);
  assert.doesNotMatch(shell, /!status\?\.auth_required/);
  assert.match(login, /isExplicitAuthDisabled/);
  assert.match(gate, /resolveAuthStatusReadiness/);
  assert.match(gate, /statusError/);
  assert.match(gate, /role="alert"/);
});
