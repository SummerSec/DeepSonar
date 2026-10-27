/**
 * #761：官方运行时镜像清单抓取层的回归测试。
 *
 * 覆盖：有界重试（只重试瞬时错误）、双通道回退、重定向后的凭据丢弃、
 * 以及「瞬时失败不降级、连续失败才用 bundled」的缓存语义。
 */

// 让 runtime-images 的重试只跑 1 次，测试不需要等待退避。
process.env.DEEPSONAR_RUNTIME_REGISTRY_FETCH_ATTEMPTS = "1";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_REGISTRY_FETCH_ATTEMPTS,
  boundedRegistryFetchAttempts,
  fetchGithubResource,
  fetchGithubResourceWithRetry,
  fetchOfficialRegistryText,
  isRetryableRegistryFetchError,
  registryAssetTarget,
} from "./runtime-image-registry-fetch.js";
import { recordPlatformUpdateCheckFromRegistry } from "./domains/platform-updates/index.js";

type FetchCall = { url: string; authorization: string | null };

/** 安装 fetch 假实现，记录每次请求的 URL 与 Authorization。 */
function installFetchMock(handler: (call: FetchCall, index: number) => Response | Promise<Response>): {
  calls: FetchCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : String((input as { url?: unknown } | null)?.url ?? input);
    const headers = new Headers(init?.headers);
    const call = { url, authorization: headers.get("authorization") };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

const noSleep = async () => {};

test("超时后重试一次即成功：不再因单次链路抖动判失败", async () => {
  let attempt = 0;
  const mock = installFetchMock(() => {
    attempt += 1;
    if (attempt === 1) throw timeoutError();
    return new Response("ok", { status: 200 });
  });
  try {
    const text = await fetchGithubResourceWithRetry(
      new URL("https://github.com/SummerSec/DeepSonar/releases/latest/download/runtime-image-registry.json"),
      "application/json",
      undefined,
      { attempts: 3, backoffMs: [0], sleep: noSleep },
    );
    assert.equal(text, "ok");
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("重试耗尽后抛出原始超时：错误可被归一化为 timed out", async () => {
  const mock = installFetchMock(() => { throw timeoutError(); });
  try {
    await assert.rejects(
      fetchGithubResourceWithRetry(new URL("https://github.com/x/y.json"), "application/json", undefined, {
        attempts: 3,
        backoffMs: [0],
        sleep: noSleep,
      }),
      (error: unknown) => {
        assert.equal(isRetryableRegistryFetchError(error), true);
        return error instanceof DOMException && error.name === "TimeoutError";
      },
    );
    assert.equal(mock.calls.length, 3);
  } finally {
    mock.restore();
  }
});

test("HTTP 404 不重试：鉴权/缺失类错误重试也不会成功", async () => {
  const mock = installFetchMock(() => new Response("missing", { status: 404 }));
  try {
    await assert.rejects(
      fetchGithubResourceWithRetry(new URL("https://github.com/x/y.json"), "application/json", undefined, {
        attempts: 3,
        backoffMs: [0],
        sleep: noSleep,
      }),
      (error: unknown) => {
        assert.equal(isRetryableRegistryFetchError(error), false);
        return error instanceof Error && error.message === "HTTP 404";
      },
    );
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("HTTP 503 属于瞬时错误：重试后成功", async () => {
  let attempt = 0;
  const mock = installFetchMock(() => {
    attempt += 1;
    return attempt === 1 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 });
  });
  try {
    const text = await fetchGithubResourceWithRetry(new URL("https://github.com/x/y.json"), "application/json", undefined, {
      attempts: 3,
      backoffMs: [0],
      sleep: noSleep,
    });
    assert.equal(text, "ok");
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("重定向到 release-assets 后丢弃凭据，且仍在信任边界内", async () => {
  const mock = installFetchMock((call) => {
    if (call.url.startsWith("https://github.com/")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://release-assets.githubusercontent.com/asset?x=1" },
      });
    }
    return new Response("body", { status: 200 });
  });
  try {
    const text = await fetchGithubResource(new URL("https://github.com/x/y.json"), "application/json", "secret-token");
    assert.equal(text, "body");
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0]?.authorization, "Bearer secret-token");
    assert.equal(mock.calls[1]?.authorization, null, "跨注册域后不得携带 Authorization");
  } finally {
    mock.restore();
  }
});

test("allowlist 外的主机在发请求前就被拒绝", async () => {
  const mock = installFetchMock(() => new Response("should-not-happen", { status: 200 }));
  try {
    await assert.rejects(
      fetchGithubResource(new URL("https://evil.example/registry.json"), "application/json"),
      /official registry host rejected/,
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("无 token 时公开通道失败会回退 api.github.com 的 release asset", async () => {
  const release = JSON.stringify({
    assets: [{ name: "runtime-image-registry.json", url: "https://api.github.com/repos/x/y/releases/assets/9" }],
  });
  const mock = installFetchMock((call) => {
    if (call.url.includes("releases/latest/download")) throw timeoutError();
    if (call.url.endsWith("/releases/latest")) return new Response(release, { status: 200 });
    if (call.url.endsWith("/releases/assets/9")) return new Response("registry-json", { status: 200 });
    return new Response("unexpected", { status: 500 });
  });
  try {
    const text = await fetchOfficialRegistryText({ attempts: 1, backoffMs: [0], sleep: noSleep });
    assert.equal(text, "registry-json");
    assert.deepEqual(mock.calls.map((call) => call.url), [
      "https://github.com/SummerSec/DeepSonar/releases/latest/download/runtime-image-registry.json",
      "https://api.github.com/repos/SummerSec/DeepSonar/releases/latest",
      "https://api.github.com/repos/x/y/releases/assets/9",
    ]);
  } finally {
    mock.restore();
  }
});

test("有 token 时直接走 api.github.com 两跳，不触碰公开通道", async () => {
  const release = JSON.stringify({
    assets: [{ name: "runtime-image-registry.json", url: "https://api.github.com/repos/x/y/releases/assets/1" }],
  });
  const mock = installFetchMock((call) => {
    if (call.url.endsWith("/releases/latest")) return new Response(release, { status: 200 });
    return new Response("registry-json", { status: 200 });
  });
  try {
    const text = await fetchOfficialRegistryText({ token: "tok", attempts: 1, sleep: noSleep });
    assert.equal(text, "registry-json");
    assert.equal(mock.calls.length, 2);
    assert.ok(mock.calls.every((call) => call.url.startsWith("https://api.github.com/")));
  } finally {
    mock.restore();
  }
});

test("release 元数据里缺少清单资产或指向非 api 主机时 fail closed", () => {
  assert.throws(() => registryAssetTarget(JSON.stringify({ assets: [] })), /official registry asset missing/);
  assert.throws(
    () => registryAssetTarget(JSON.stringify({ assets: [{ name: "runtime-image-registry.json", url: "https://evil.example/x" }] })),
    /official registry asset host rejected/,
  );
  assert.throws(() => registryAssetTarget("not-json"), /official release metadata invalid/);
});

test("attempts 被夹到 1–5，避免运维误配放大请求量", () => {
  assert.equal(boundedRegistryFetchAttempts(0), 1);
  assert.equal(boundedRegistryFetchAttempts(-3), 1);
  assert.equal(boundedRegistryFetchAttempts(9), 5);
  assert.equal(boundedRegistryFetchAttempts(Number.NaN), DEFAULT_REGISTRY_FETCH_ATTEMPTS);
  assert.equal(boundedRegistryFetchAttempts(undefined), DEFAULT_REGISTRY_FETCH_ATTEMPTS);
});

test("瞬时失败沿用上次成功清单，连续到阈值才降级 bundled", async () => {
  const { loadRuntimeImageRegistry, resetRemoteRuntimeImageRegistryCacheForTests } = await import("./runtime-images.js");
  const bundled = await readFile(path.resolve(process.cwd(), "../../deploy/runtime-image-registry.json"), "utf8");
  resetRemoteRuntimeImageRegistryCacheForTests();
  let healthy = true;
  const mock = installFetchMock(() => {
    if (!healthy) throw timeoutError();
    return new Response(bundled, { status: 200 });
  });
  try {
    const fresh = await loadRuntimeImageRegistry({ refreshRemote: true });
    assert.equal(fresh.source, "remote");
    assert.equal(fresh.fallback, false);
    assert.equal(fresh.stale, undefined);
    assert.equal(fresh.error, null);

    healthy = false;
    const stale = await loadRuntimeImageRegistry({ refreshRemote: true });
    assert.equal(stale.source, "remote", "单次失败不得退回 bundled");
    assert.equal(stale.fallback, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.consecutive_failures, 1);
    assert.match(String(stale.error), /timed out/);
    assert.ok(stale.last_success_at, "保留上次成功时间");

    await loadRuntimeImageRegistry({ refreshRemote: true }); // 第 2 次失败
    const degraded = await loadRuntimeImageRegistry({ refreshRemote: true }); // 第 3 次失败 → 降级
    assert.equal(degraded.source, "bundled");
    assert.equal(degraded.fallback, true);
    assert.equal(degraded.consecutive_failures, 3);
  } finally {
    mock.restore();
    resetRemoteRuntimeImageRegistryCacheForTests();
  }
});

test("stale 清单不写平台更新检查，避免横幅随单次抖动翻转", async () => {
  let dbCalls = 0;
  const fakeDb = (async () => { dbCalls += 1; return []; }) as unknown as Parameters<typeof recordPlatformUpdateCheckFromRegistry>[1];
  const registry = {
    schema: "deepsonar.registry/v1",
    images: [],
    source: "remote",
    fallback: false,
    stale: true,
    error: "remote registry request timed out",
    consecutive_failures: 1,
  } as unknown as Parameters<typeof recordPlatformUpdateCheckFromRegistry>[0];
  const skipped = await recordPlatformUpdateCheckFromRegistry(registry, fakeDb);
  assert.equal(skipped, null);
  assert.equal(dbCalls, 0, "stale 检查不得覆盖上一行结果");
});