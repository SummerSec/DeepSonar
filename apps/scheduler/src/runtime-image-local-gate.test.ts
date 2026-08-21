import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  assertFrozenRuntimeImageLocal,
  runtimeImageHttpError,
  runtimeImageNotLocalCanvasBlock,
  RuntimeImageNotLocalError,
  RuntimeImageNotReadyError,
  RUNTIME_IMAGE_NOT_LOCAL,
  shortRuntimeImageDigest,
} from "./runtime-images.js";
const DIGEST = `sha256:${"1".repeat(64)}`;
const LATEST = `sha256:${"2".repeat(64)}`;
const FROZEN_REF = `registry.example/deepsonar-audit@${DIGEST}`;
const LATEST_REF = `registry.example/deepsonar-audit@${LATEST}`;

const frozenSnapshot = {
  name: "audit",
  runtime_image_key: "deepsonar-audit",
  runtime_image: {
    image_key: "deepsonar-audit",
    image_ref: FROZEN_REF,
    image_digest: DIGEST,
    image_version: "0.1.41",
    runtime_image_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
};

test("inspect miss fails closed and does not call insert", async () => {
  let inserted = 0;
  const insert = () => {
    inserted += 1;
    return { id: "job" };
  };
  await assert.rejects(
    async () => {
      await assertFrozenRuntimeImageLocal(frozenSnapshot, {
        inspect: async () => ({ exists: false }),
      });
      insert();
    },
    (error: unknown) => error instanceof RuntimeImageNotLocalError
      && error.httpCode === RUNTIME_IMAGE_NOT_LOCAL
      && error instanceof RuntimeImageNotReadyError
      && error.image_key === "deepsonar-audit"
      && error.version === "0.1.41"
      && error.digest === DIGEST
      && error.imageRef === FROZEN_REF,
  );
  assert.equal(inserted, 0);
});

test("inspect hit leaves the create path unchanged", async () => {
  let inserted = 0;
  await assertFrozenRuntimeImageLocal(frozenSnapshot, {
    inspect: async () => ({ exists: true, repo_digests: [FROZEN_REF] }),
  });
  inserted += 1;
  assert.equal(inserted, 1);
});

test("resume inspects the frozen digest, not latest", async () => {
  const inspected: string[] = [];
  await assert.rejects(
    () => assertFrozenRuntimeImageLocal(frozenSnapshot, {
      inspect: async (ref) => {
        inspected.push(ref);
        return { exists: false };
      },
    }),
    RuntimeImageNotLocalError,
  );
  assert.ok(inspected.includes(FROZEN_REF));
  assert.ok(inspected.every((ref) => ref === FROZEN_REF || ref === DIGEST));
  assert.equal(inspected.includes(LATEST_REF), false);
  assert.equal(inspected.includes(LATEST), false);
});

test("fake mode and explicit skip do not inspect the host", async () => {
  let inspected = 0;
  await assertFrozenRuntimeImageLocal(frozenSnapshot, { requireLocal: false });
  await assertFrozenRuntimeImageLocal(frozenSnapshot, {
    inspect: async () => {
      inspected += 1;
      return { exists: true, repo_digests: [FROZEN_REF] };
    },
  });
  assert.equal(inspected, 1);
  assert.match(readFileSync(new URL("./runtime-images.ts", import.meta.url), "utf8"), /shouldInspectLocalRuntimeImage/);
  assert.match(readFileSync(new URL("./readiness.ts", import.meta.url), "utf8"), /executionMode === "fake"/);
});

test("HTTP mapping exposes digest, immutable ref and prepare entry", () => {
  const error = new RuntimeImageNotLocalError({
    image_key: "deepsonar-audit",
    version: "0.1.41",
    digest: DIGEST,
    image_ref: FROZEN_REF,
    role_name: "audit",
  });
  const mapped = runtimeImageHttpError(error);
  assert.equal(mapped?.statusCode, 409);
  assert.equal(mapped?.body.error_code, RUNTIME_IMAGE_NOT_LOCAL);
  assert.equal(mapped?.body.reason, "runtime_image_not_ready");
  assert.equal(mapped?.body.image_key, "deepsonar-audit");
  assert.equal(mapped?.body.version, "0.1.41");
  assert.equal(mapped?.body.digest, DIGEST);
  assert.equal(mapped?.body.image_ref, FROZEN_REF);
  assert.deepEqual(mapped?.body.prepare, { method: "GET", path: "/runtime-images/registry/pull-status" });
  assert.equal(mapped?.body.next_action, "prepare-frozen-digest-or-rerun-current");
  const block = runtimeImageNotLocalCanvasBlock(error.details);
  assert.equal(block.kind, "runtime_image_not_local");
  assert.match(block.reason, /0\.1\.41/);
  assert.match(block.reason, /sha256:111111111111/);
  assert.equal(shortRuntimeImageDigest(DIGEST), "sha256:111111111111…");
});
