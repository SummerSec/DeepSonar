import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveMinRuntimeImageVersion,
  isRuntimeImageBelowPlatformMin,
  parseRuntimeImageRegistry,
  runtimeImageHttpError,
  runtimeImageVersionCore,
  RuntimeImageBelowPlatformMinError,
} from "./runtime-images.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("runtime image version core reads the leading X.Y.Z", () => {
  assert.equal(runtimeImageVersionCore("0.2.6"), "0.2.6");
  assert.equal(runtimeImageVersionCore("v0.2.7-linux-amd64"), "0.2.7");
  assert.equal(runtimeImageVersionCore("configured-ab12cd"), null);
});

test("effective min prefers per-key overrides then the global floor", () => {
  assert.equal(effectiveMinRuntimeImageVersion(null, "deepsonar-base"), null);
  assert.equal(effectiveMinRuntimeImageVersion({ version: "0.2.7" }, "deepsonar-base"), "0.2.7");
  assert.equal(effectiveMinRuntimeImageVersion({
    version: "0.2.7",
    by_image_key: { "deepsonar-kali-minimal": "0.2.8" },
  }, "deepsonar-kali-minimal"), "0.2.8");
  assert.equal(effectiveMinRuntimeImageVersion({
    version: "0.2.7",
    by_image_key: { "deepsonar-kali-minimal": "0.2.8" },
  }, "deepsonar-base"), "0.2.7");
});

test("official versions below the platform floor fail closed", () => {
  const min = { version: "0.2.7" };
  assert.equal(isRuntimeImageBelowPlatformMin({
    official: true, version: "0.2.6", imageKey: "deepsonar-base", min,
  }), true);
  assert.equal(isRuntimeImageBelowPlatformMin({
    official: true, version: "0.2.7", imageKey: "deepsonar-base", min,
  }), false);
  assert.equal(isRuntimeImageBelowPlatformMin({
    official: true, version: "0.2.10", imageKey: "deepsonar-base", min,
  }), false);
  assert.equal(isRuntimeImageBelowPlatformMin({
    official: false, version: "0.1.0", imageKey: "third-party", min,
  }), false);
  assert.equal(isRuntimeImageBelowPlatformMin({
    official: true, version: "0.2.6", imageKey: "deepsonar-base", min: null,
  }), false);
});

test("parser accepts platform_version and min_runtime_image, and rejects invalid floors", () => {
  const payload = {
    schema: "deepsonar.registry/v2" as const,
    schema_version: 2 as const,
    platform_version: "0.2.10",
    min_runtime_image: { version: "0.2.7", by_image_key: { "deepsonar-base": "0.2.8" } },
    images: [{
      image_key: "deepsonar-base",
      name: "Base",
      description: "base",
      publisher: "SummerSec",
      source_kind: "official" as const,
      project_opt_in: false,
      versions: [{
        version: "0.2.10",
        digest: DIGEST,
        platforms: ["linux/amd64"],
        size_bytes: 1,
        registry_refs: { github: `ghcr.io/summersec/deepsonar-base@${DIGEST}` },
        registry_evidence: {
          github: {
            available: true,
            ref: `ghcr.io/summersec/deepsonar-base@${DIGEST}`,
            inspect_digest: DIGEST,
            provenance: "build-push+inspect",
          },
          dockerhub: { available: false, provenance: "unavailable", reason: "credentials_missing" },
          "aliyun-acr": { available: false, provenance: "unavailable", reason: "credentials_missing" },
        },
      }],
    }],
  };
  const parsed = parseRuntimeImageRegistry(payload);
  assert.equal(parsed.platform_version, "0.2.10");
  assert.equal(parsed.min_runtime_image?.version, "0.2.7");
  assert.equal(parsed.min_runtime_image?.by_image_key?.["deepsonar-base"], "0.2.8");
  assert.throws(() => parseRuntimeImageRegistry({
    ...payload,
    min_runtime_image: { version: "latest" },
  }), /X\.Y\.Z|min_runtime_image/i);
  assert.doesNotThrow(() => parseRuntimeImageRegistry({
    schema: "deepsonar.registry/v2",
    images: payload.images,
  }));
});

test("below-platform-min HTTP mapping is 409 with a stable error code", () => {
  const error = new RuntimeImageBelowPlatformMinError("deepsonar-base", "0.2.6", "0.2.7", "img", "proj");
  const mapped = runtimeImageHttpError(error);
  assert.equal(mapped?.statusCode, 409);
  assert.equal(mapped?.body.error_code, "RUNTIME_IMAGE_BELOW_PLATFORM_MIN");
  assert.equal(mapped?.body.image_key, "deepsonar-base");
  assert.equal(mapped?.body.selected_version, "0.2.6");
  assert.equal(mapped?.body.min_version, "0.2.7");
  assert.match(String(mapped?.body.error), /0\.2\.6/);
  assert.match(String(mapped?.body.error), /0\.2\.7/);
});
