import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotUnresolvableError } from "./domains/role-runtime-snapshot/index.js";
import {
  invalidRuntimeImage,
  isHubRuntimeImageResolutionError,
} from "./control-input.js";

test("CLI and missing trusted image snapshot failures map to invalid_runtime_image", () => {
  assert.equal(
    isHubRuntimeImageResolutionError(new Error("AGENT_CLI_IMAGE_INCOMPATIBLE: dsh cannot run in deepsonar-chrome-fuzz")),
    true,
  );
  assert.equal(
    isHubRuntimeImageResolutionError(new SnapshotUnresolvableError(
      new Error("角色 review 没有可用的可信运行镜像版本（key=deepsonar-ghost）；请先准入 digest 并为项目启用"),
    )),
    true,
  );
  assert.equal(isHubRuntimeImageResolutionError(new Error("Credential x 不可用")), false);
  const mapped = invalidRuntimeImage("intents.0.runtime_image_key", ["deepsonar-base"]);
  assert.equal(mapped.code, "invalid_runtime_image");
  assert.equal(mapped.retryable, true);
  assert.match(mapped.message, /CLI 兼容/);
});
