import assert from "node:assert/strict";
import test from "node:test";
import {
  executeRuntimeImageGcPlan,
  planRuntimeImageGc,
  type RuntimeImageGcVersion,
} from "./runtime-image-gc.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const version = (
  id: string,
  product: string,
  createdAt: string,
  options: Partial<RuntimeImageGcVersion> = {},
): RuntimeImageGcVersion => {
  const imageDigest = digest(id[0] ?? "a");
  return {
    id,
    runtimeImageId: product,
    version: id,
    digest: imageDigest,
    promotedAt: null,
    createdAt,
    refs: [`ghcr.io/summersec/${product}@${imageDigest}`],
    ...options,
  };
};

test("runtime image GC protects promoted, rollback, project pins and queued/active snapshots", () => {
  const versions = [
    version("a-current", "base", "2026-08-04T00:00:00Z", { promotedAt: "2026-08-04T00:00:00Z" }),
    version("b-rollback", "base", "2026-08-03T00:00:00Z"),
    version("c-pinned", "base", "2026-08-02T00:00:00Z"),
    version("d-active", "base", "2026-08-01T00:00:00Z"),
    version("e-gc", "base", "2026-07-31T00:00:00Z"),
  ];
  const plan = planRuntimeImageGc(versions, new Set(["c-pinned"]), new Set(["d-active"]));
  assert.deepEqual(plan.candidates.map((item) => item.id), ["e-gc"]);
  assert.deepEqual(
    [...plan.protectedVersionIds].sort(),
    ["a-current", "b-rollback", "c-pinned", "d-active"],
  );
});

test("runtime image GC removes only DB-known immutable refs without force", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
  const calls: string[][] = [];
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async (...args) => {
      calls.push(args);
      return "";
    },
  );
  assert.equal(result.removed, 1);
  assert.deepEqual(calls[0], ["ps", "-aq", "--filter", `ancestor=${candidate.refs[0]}`]);
  assert.deepEqual(calls[1], ["image", "rm", candidate.refs[0]!]);
  assert.equal(calls.flat().includes("-f"), false);
});

test("runtime image GC retains a version referenced by any container", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
  const calls: string[][] = [];
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async (...args) => {
      calls.push(args);
      return args[0] === "ps" ? "container-id" : "";
    },
  );
  assert.equal(result.retainedInUse, 1);
  assert.equal(result.removed, 0);
  assert.equal(calls.some((args) => args[0] === "image"), false);
});

test("runtime image GC fails closed when a DB row lacks a matching named immutable ref", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z", {
    refs: ["ghcr.io/summersec/base:latest", `ghcr.io/summersec/base@${digest("d")}`],
  });
  let calls = 0;
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async () => {
      calls += 1;
      return "";
    },
  );
  assert.equal(result.unsafeRef, 1);
  assert.equal(result.removed, 0);
  assert.equal(calls, 0);
});
