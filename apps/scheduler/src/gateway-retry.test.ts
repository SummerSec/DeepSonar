import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchGatewayUpstream,
  gatewayAttemptTimeoutMs,
  gatewayJobDeadlineMs,
  GatewayUpstreamUnreachableError,
} from "./gateway.js";

const request = {
  url: "http://127.0.0.1/v1/messages",
  init: { method: "POST", headers: { "content-type": "application/json" } },
  upstreamTimeoutMs: 3_000_000,
};

function noOpSignal(): AbortSignal {
  return new AbortController().signal;
}

function response(status: number, body = String(status)): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

test("502 -> 502 -> 200 只在响应头交付前重试", async () => {
  const statuses = [502, 502, 200];
  const delays: number[] = [];
  let calls = 0;
  const result = await fetchGatewayUpstream(request, {
    fetchFn: async () => response(statuses[calls++]!),
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
    random: () => 0.5,
    createTimeoutSignal: noOpSignal,
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.retryReasons, ["http", "http"]);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(calls, 3);
});

test("network -> 200 会重试一次", async () => {
  let calls = 0;
  const result = await fetchGatewayUpstream(request, {
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) throw new Error("连接断开");
      return response(200, "ok");
    },
    sleep: async () => undefined,
    random: () => 0.5,
    createTimeoutSignal: noOpSignal,
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.retryReasons, ["network"]);
  assert.equal(calls, 2);
});

test("timeout -> 200 会重试一次", async () => {
  let calls = 0;
  const result = await fetchGatewayUpstream(request, {
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("请求超时");
        error.name = "TimeoutError";
        throw error;
      }
      return response(200, "ok");
    },
    sleep: async () => undefined,
    random: () => 0.5,
    createTimeoutSignal: noOpSignal,
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.retryReasons, ["timeout"]);
  assert.equal(calls, 2);
});

test("400 是永久错误，不重试且保留原始响应", async () => {
  let calls = 0;
  const result = await fetchGatewayUpstream(request, {
    fetchFn: async () => {
      calls += 1;
      return response(400, "invalid request");
    },
    sleep: async () => undefined,
    createTimeoutSignal: noOpSignal,
  });

  assert.equal(result.response.status, 400);
  assert.equal(await result.response.text(), "invalid request");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.retryReasons, []);
  assert.equal(calls, 1);
});

test("连续网络失败最多三次，最终返回稳定 upstream_unreachable 错误", async () => {
  let calls = 0;
  await assert.rejects(
    fetchGatewayUpstream(request, {
      fetchFn: async () => {
        calls += 1;
        throw new Error("provider down");
      },
      sleep: async () => undefined,
      random: () => 0.5,
      createTimeoutSignal: noOpSignal,
    }),
    (error: unknown) => {
      assert.equal(error instanceof GatewayUpstreamUnreachableError, true);
      assert.equal((error as GatewayUpstreamUnreachableError).message, "上游不可达");
      assert.equal((error as GatewayUpstreamUnreachableError).attempts, 3);
      assert.deepEqual((error as GatewayUpstreamUnreachableError).retryReasons, ["network", "network"]);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("连续 502 三次保留最终上游 status/body 并标记 HTTP 耗尽", async () => {
  let calls = 0;
  const result = await fetchGatewayUpstream(request, {
    fetchFn: async () => response(502, `attempt-${++calls}`),
    sleep: async () => undefined,
    random: () => 0.5,
    createTimeoutSignal: noOpSignal,
  });

  assert.equal(result.response.status, 502);
  assert.equal(await result.response.text(), "attempt-3");
  assert.equal(result.attempts, 3);
  assert.equal(result.exhaustedReason, "http");
  assert.equal(calls, 3);
});

test("200 SSE 响应体后续读取失败不会触发重试", async () => {
  let calls = 0;
  let failStream: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\\n\\n"));
      failStream = () => controller.error(new Error("SSE 断流"));
    },
  });
  const result = await fetchGatewayUpstream(request, {
    fetchFn: async () => {
      calls += 1;
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    sleep: async () => undefined,
    createTimeoutSignal: noOpSignal,
  });

  const reader = result.response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  failStream!();
  await assert.rejects(reader.read());
  assert.equal(calls, 1);
});

test("Job 剩余预算同时限制每次 attempt 和后续重试", async () => {
  const startedAt = "2026-08-11T00:00:00.000Z";
  const deadline = gatewayJobDeadlineMs(startedAt, 0.5);
  assert.equal(deadline, Date.parse(startedAt) + 500);
  assert.equal(gatewayAttemptTimeoutMs(3_000_000, deadline, Date.parse(startedAt)), 500);
  assert.equal(gatewayAttemptTimeoutMs(3_000_000, deadline, Date.parse(startedAt) + 200), 300);

  let current = Date.parse(startedAt);
  let calls = 0;
  const signalTimeouts: number[] = [];
  const result = await fetchGatewayUpstream({ ...request, jobDeadlineMs: deadline }, {
    now: () => current,
    createTimeoutSignal: (timeoutMs) => {
      signalTimeouts.push(timeoutMs);
      return noOpSignal();
    },
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) {
        current += 50;
        return response(502);
      }
      return response(200, "ok");
    },
    sleep: async (delayMs) => {
      current += delayMs;
    },
    random: () => 0.5,
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(signalTimeouts, [500, 350]);
  assert.equal(current < deadline!, true);
});

test("Job 剩余时间不足下一次退避时不再发起 fetch", async () => {
  const deadline = 150;
  let current = 0;
  let calls = 0;
  const result = await fetchGatewayUpstream({ ...request, jobDeadlineMs: deadline }, {
    now: () => current,
    createTimeoutSignal: (timeoutMs) => {
      assert.equal(timeoutMs, 150);
      return noOpSignal();
    },
    fetchFn: async () => {
      calls += 1;
      current = 100;
      return response(502, "final");
    },
    sleep: async () => {
      throw new Error("不应进入退避等待");
    },
    random: () => 0.5,
  });

  assert.equal(result.response.status, 502);
  assert.equal(result.exhaustedReason, "http");
  assert.equal(await result.response.text(), "final");
  assert.equal(calls, 1);
});
