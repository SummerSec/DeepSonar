import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ApiRequestError,
  authFormErrorMessage,
  formatLoginRateLimitedMessage,
  formatRetryAfterTiming,
  isLoginRateLimited,
  parseRetryAfterSec,
} from "./login-error";

test("retry timing formats minutes and seconds in Chinese", () => {
  assert.equal(formatRetryAfterTiming(45), "45 秒");
  assert.equal(formatRetryAfterTiming(60), "1 分钟");
  assert.equal(formatRetryAfterTiming(65), "1 分 5 秒");
  assert.equal(formatRetryAfterTiming(300), "5 分钟");
});

test("LOGIN_RATE_LIMITED message includes retry timing when known", () => {
  assert.equal(formatLoginRateLimitedMessage(125), "登录尝试过于频繁，请约 2 分 5 秒 后再试");
  assert.equal(formatLoginRateLimitedMessage(null), "登录尝试过于频繁，请稍后再试");
  assert.equal(formatLoginRateLimitedMessage(undefined), "登录尝试过于频繁，请稍后再试");
});

test("ApiRequestError for login 429 uses Chinese UX copy, not raw POST path", () => {
  const err = new ApiRequestError({
    method: "POST",
    path: "/auth/login",
    status: 429,
    errorCode: "LOGIN_RATE_LIMITED",
    serverMessage: "登录尝试过于频繁，请稍后再试",
    retryAfterSec: 180,
  });
  assert.equal(err.errorCode, "LOGIN_RATE_LIMITED");
  assert.equal(err.retryAfterSec, 180);
  assert.equal(err.message, "登录尝试过于频繁，请约 3 分钟 后再试");
  assert.doesNotMatch(err.message, /POST \/auth\/login/u);
  assert.equal(authFormErrorMessage(err), err.message);
});

test("ordinary login failures keep machine-readable detail for operators", () => {
  const err = new ApiRequestError({
    method: "POST",
    path: "/auth/login",
    status: 401,
    errorCode: "BAD_CREDENTIALS",
    serverMessage: "用户名或密码错误",
  });
  assert.match(err.message, /POST \/auth\/login -> 401: BAD_CREDENTIALS: 用户名或密码错误/);
  assert.equal(authFormErrorMessage(err), "用户名或密码错误");
});

test("parseRetryAfterSec prefers body then Retry-After header", () => {
  assert.equal(parseRetryAfterSec({ retry_after_sec: 42 }, "9"), 42);
  assert.equal(parseRetryAfterSec({}, "17"), 17);
  assert.equal(parseRetryAfterSec(null, "nope"), null);
});

test("isLoginRateLimited recognizes code and login/bootstrap 429", () => {
  assert.equal(isLoginRateLimited({ errorCode: "LOGIN_RATE_LIMITED" }), true);
  assert.equal(isLoginRateLimited({ status: 429, path: "/auth/login" }), true);
  assert.equal(isLoginRateLimited({ status: 429, path: "/auth/bootstrap" }), true);
  assert.equal(isLoginRateLimited({ status: 429, path: "/workers/register" }), false);
});

test("authFormErrorMessage upgrades legacy POST /auth/login -> 429 strings", () => {
  const msg = authFormErrorMessage(
    new Error("POST /auth/login -> 429: LOGIN_RATE_LIMITED: 登录尝试过于频繁，请稍后再试"),
  );
  assert.equal(msg, "登录尝试过于频繁，请稍后再试");
  assert.doesNotMatch(msg, /POST \/auth\/login/u);
});

test("LoginPage wires reveal toggle and authFormErrorMessage", () => {
  const login = readFileSync(new URL("./pages/LoginPage.tsx", import.meta.url), "utf8");
  assert.match(login, /from "\.\.\/login-error"/u);
  assert.match(login, /authFormErrorMessage/u);
  assert.match(login, /显示密码/u);
  assert.match(login, /显示 Token/u);
  assert.match(login, /type=\{revealed \? "text" : "password"\}/u);
  assert.match(login, /EyeSlash/u);
});

test("api.send throws ApiRequestError with retry_after_sec for login failures", () => {
  const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(api, /from "\.\/login-error"/u);
  assert.match(api, /new ApiRequestError/u);
  assert.match(api, /parseRetryAfterSec/u);
});
