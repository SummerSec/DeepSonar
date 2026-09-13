import assert from "node:assert/strict";
import test from "node:test";

// config 在 import 时读 env；broker 地址与 fetch 由每段测试内的 stub 接管。
process.env.DEEPSONAR_DEVICE_ENABLED = "true";
process.env.DEEPSONAR_DEVICE_BROKER_URL = "http://127.0.0.1:8798";
process.env.DEEPSONAR_DEVICE_BROKER_TOKEN = "broker-inbound-token";
process.env.DEEPSONAR_DEVICE_TRANSPORTS = "adb,hdc";

const rigRows = [
  {
    key: "rig-1",
    transport: "adb",
    model: "Pixel-7",
    status: "idle",
    updated_at: new Date("2026-09-13T10:00:00Z"),
  },
  {
    key: "rig-2",
    transport: "adb",
    model: null,
    status: "maintenance",
    updated_at: new Date("2026-09-13T11:00:00Z"),
  },
  {
    key: "oh-1",
    transport: "hdc",
    model: null,
    status: "leased",
    updated_at: new Date("2026-09-13T12:00:00Z"),
  },
  {
    key: "gone",
    transport: "serial",
    model: null,
    status: "idle",
    updated_at: new Date("2026-09-13T13:00:00Z"),
  },
  {
    key: "rig-3",
    transport: "adb",
    model: "Pixel-8",
    status: "revoked",
    updated_at: new Date("2026-09-13T14:00:00Z"),
  },
];

function withStubFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  run: (
    calls: Array<{ url: string; method: string; body: unknown }>,
  ) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init?.method ?? "GET"),
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
    });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

test("desired set drops revoked/maintenance rows and unimplemented transports", async () => {
  const { desiredRigDevices } = await import("./rig-registry.js");
  const desired = desiredRigDevices(rigRows);
  assert.deepEqual(desired.map((device) => device.key).sort(), [
    "oh-1",
    "rig-1",
  ]);
  assert.equal(
    desired.find((device) => device.key === "rig-1")?.model,
    "Pixel-7",
  );
});

test("next revision is strictly newer than the broker's and never behind the newest row", async () => {
  const { nextRigRevision } = await import("./rig-registry.js");
  const newest = new Date("2026-09-13T20:00:00Z").getTime();
  // broker 落后：取 max(broker+1, newest)
  assert.equal(nextRigRevision(5, [{ updatedAtMs: newest }]), newest);
  // broker 领先：不能回退
  assert.equal(
    nextRigRevision(newest + 10, [{ updatedAtMs: newest }]),
    newest + 11,
  );
  assert.equal(nextRigRevision(Number.NaN, [{ updatedAtMs: Number.NaN }]), 1);
});

test("push reads the broker revision first and sends the monotonic one", async () => {
  const { pushRigAdmission, desiredRigDevices } = await import(
    "./rig-registry.js"
  );
  const desired = desiredRigDevices(rigRows);
  await withStubFetch(
    async (_url, init) => {
      if (String(init.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            revision: 41,
            reconciled: true,
            mode: "platform",
            usable: [],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({ applied: true, revision: 42, mode: "platform" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    async (calls) => {
      const outcome = await pushRigAdmission(desired);
      assert.deepEqual(outcome, { ok: true, revision: 42, mode: "platform" });
      assert.deepEqual(
        calls.map((call) => [call.method, call.url]),
        [
          ["GET", "http://127.0.0.1:8798/rig/devices"],
          ["PUT", "http://127.0.0.1:8798/rig/devices"],
        ],
      );
      const body = calls[1]!.body as {
        revision: number;
        devices: Array<{ key: string }>;
      };
      // revision 必须大于 broker 当前值（41），且集合里不能出现下架/未实现的条目。
      assert.ok(body.revision > 41, `revision 必须单调：${body.revision}`);
      assert.deepEqual(body.devices.map((device) => device.key).sort(), [
        "oh-1",
        "rig-1",
      ]);
    },
  );
});

test("push maps broker refusals to stable reasons without echoing the body", async () => {
  const { pushRigAdmission } = await import("./rig-registry.js");
  const cases: Array<{ status: number; reason: string }> = [
    { status: 409, reason: "stale_revision" },
    { status: 401, reason: "unauthorized" },
    { status: 403, reason: "unauthorized" },
    { status: 500, reason: "unavailable" },
  ];
  for (const item of cases) {
    await withStubFetch(
      async (_url, init) =>
        String(init.method ?? "GET") === "GET"
          ? new Response(
              JSON.stringify({
                revision: 3,
                reconciled: true,
                mode: "platform",
                usable: [],
              }),
              { status: 200 },
            )
          : new Response(
              JSON.stringify({ error: "internal detail must not leak" }),
              { status: item.status },
            ),
      async () => {
        const outcome = await pushRigAdmission([
          { key: "rig-1", transport: "adb", model: null, updatedAtMs: 1 },
        ]);
        assert.deepEqual(outcome, { ok: false, reason: item.reason });
      },
    );
  }
  // 网络失败与契约不符都归为 unavailable（调用方下一轮读回后决定）。
  await withStubFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      const outcome = await pushRigAdmission([]);
      assert.deepEqual(outcome, { ok: false, reason: "unavailable" });
    },
  );
  await withStubFetch(
    async (_url, init) =>
      String(init.method ?? "GET") === "GET"
        ? new Response(
            JSON.stringify({
              revision: 3,
              reconciled: true,
              mode: "platform",
              usable: [],
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ applied: true }), { status: 200 }),
    async () => {
      const outcome = await pushRigAdmission([]);
      assert.deepEqual(outcome, { ok: false, reason: "unavailable" });
    },
  );
});

test("readRigAdmission refuses to guess on malformed broker payloads", async () => {
  const { readRigAdmission } = await import("./rig-registry.js");
  await withStubFetch(
    async () =>
      new Response(JSON.stringify({ mode: "platform" }), { status: 200 }),
    async () => {
      assert.equal(await readRigAdmission(), null);
    },
  );
  await withStubFetch(
    async () => new Response("not json", { status: 200 }),
    async () => {
      assert.equal(await readRigAdmission(), null);
    },
  );
  await withStubFetch(
    async () =>
      new Response(
        JSON.stringify({
          revision: 9,
          reconciled: true,
          mode: "platform-and-ceiling",
          usable: ["rig-1"],
        }),
        {
          status: 200,
        },
      ),
    async () => {
      assert.deepEqual(await readRigAdmission(), {
        revision: 9,
        reconciled: true,
        mode: "platform-and-ceiling",
        usable: ["rig-1"],
      });
    },
  );
});
