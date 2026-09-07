import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_INPUT_ERROR_CODES } from "./control-input.js";
import {
  assertHubRuntimeImageReady,
  classifyRuntimeImageReadinessFromState,
} from "./runtime-image-readiness.js";
import { redactRuntimeImageReadinessError } from "./runtime-image-pull-status.js";
import type { RuntimeImagePullTask } from "./runtime-image-pull-status.js";

function pull(overrides: Partial<RuntimeImagePullTask> = {}): RuntimeImagePullTask {
  return {
    task_id: "task-1",
    purpose: "admin_bulk",
    status: "running",
    started_at: "2026-09-06T00:00:00.000Z",
    finished_at: null,
    total: 1,
    completed: 0,
    items: [{
      image_key: "deepsonar-kali-minimal",
      image_ref: "ghcr.io/example/kali@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "queued",
      error: null,
    }],
    ...overrides,
  };
}

test("readiness is preparing when a matching pull item is queued or running", () => {
  const view = classifyRuntimeImageReadinessFromState({
    imageKey: "deepsonar-kali-minimal",
    imageRef: "ghcr.io/example/kali@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pull: pull(),
    localAvailable: false,
    hostManaged: true,
    checkedAt: "2026-09-06T00:00:01.000Z",
  });
  assert.equal(view.readiness, "preparing");
  assert.equal(view.preparing, true);
  assert.equal(view.task_id, "task-1");
});

test("host-managed missing layers are unavailable unless a recent pull failed", () => {
  const unavailable = classifyRuntimeImageReadinessFromState({
    imageKey: "deepsonar-base",
    imageRef: "ghcr.io/example/base@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pull: null,
    localAvailable: false,
    hostManaged: true,
  });
  assert.equal(unavailable.readiness, "unavailable");
  assert.equal(unavailable.error_code, "not_pulled");

  const failed = classifyRuntimeImageReadinessFromState({
    imageKey: "deepsonar-base",
    imageRef: "ghcr.io/example/base@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pull: pull({
      status: "failed",
      items: [{
        image_key: "deepsonar-base",
        image_ref: "ghcr.io/example/base@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        status: "failed",
        error: "docker pull exit code 1: ghcr.io/example/base@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb not found",
        error_code: "pull_failed",
      }],
    }),
    localAvailable: false,
    hostManaged: true,
  });
  assert.equal(failed.readiness, "error");
  assert.equal(failed.error_code, "pull_failed");
  assert.doesNotMatch(failed.error ?? "", /ghcr\.io/);
  assert.doesNotMatch(failed.error ?? "", /sha256:bbbb/);
});

test("non-host runtimes with a trusted digest are ready", () => {
  const view = classifyRuntimeImageReadinessFromState({
    imageKey: "deepsonar-base",
    imageRef: "ghcr.io/example/base@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    pull: null,
    localAvailable: null,
    hostManaged: false,
  });
  assert.equal(view.readiness, "ready");
  assert.equal(view.preparing, false);
});

test("Hub submit of a non-ready catalog entry is retryable runtime_image_not_ready", () => {
  assert.throws(
    () => assertHubRuntimeImageReady({
      image_key: "deepsonar-kali-minimal",
      readiness: "preparing",
      preparing: true,
      error_code: null,
      error: null,
      checked_at: "2026-09-06T00:00:00.000Z",
      task_id: "task-1",
    }),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === CONTROL_INPUT_ERROR_CODES.runtimeImageNotReady
      && "retryable" in error
      && error.retryable === true
    ),
  );
  assert.doesNotThrow(() => assertHubRuntimeImageReady({
    image_key: "deepsonar-base",
    readiness: "ready",
    preparing: false,
    error_code: null,
    error: null,
    checked_at: "2026-09-06T00:00:00.000Z",
    task_id: null,
  }));
});

test("readiness errors redact executable OCI addresses and digests", () => {
  const redacted = redactRuntimeImageReadinessError(
    "failed to pull ghcr.io/summersec/deepsonar-base@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.doesNotMatch(redacted, /ghcr\.io/);
  assert.doesNotMatch(redacted, /0123456789abcdef/);
});
