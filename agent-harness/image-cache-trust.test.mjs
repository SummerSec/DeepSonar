// #961 P2/P3: the V8 compile stage must not inherit BASE_IMAGE, and PR/CI
// builds must not be able to satisfy the release skip-if-unchanged check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { computeFingerprint } from "./image-build-fingerprint.mjs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const CI_WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/chrome-runtime.yml",
  ".github/workflows/mobile-runtime.yml",
  ".github/workflows/openharmony-runtime.yml",
];

test("the fingerprint exposes three separate src tag namespaces", () => {
  const result = computeFingerprint({ preset: "deepsonar-chrome-fuzz", platforms: "linux/arm64" });
  assert.equal(result.src_tag, `src-${result.fingerprint}`);
  assert.equal(result.ci_src_tag, `src-ci-${result.fingerprint}`);
  assert.equal(result.release_src_tag, `src-release-${result.fingerprint}`);
  assert.notEqual(result.ci_src_tag, result.release_src_tag, "CI and release must not share a skip tag");
  assert.notEqual(result.ci_src_tag, result.src_tag);
  assert.notEqual(result.release_src_tag, result.src_tag);
});

test("CI workflows write and read the namespaced tag only", () => {
  for (const file of CI_WORKFLOWS) {
    const body = read(file);
    assert.ok(body.includes("steps.fingerprint.outputs.ci_src_tag"), `${file} must use the CI namespace`);
    assert.ok(
      !body.includes("steps.fingerprint.outputs.src_tag"),
      `${file} must not touch the release-owned src tag`,
    );
  }
});

test("release uses its own namespace and never the legacy or CI tag", () => {
  const release = read(".github/workflows/release.yml");
  assert.ok(release.includes("steps.fingerprint.outputs.release_src_tag"), "release owns src-release-<fp>");
  assert.ok(!release.includes("ci_src_tag"), "release must not read PR-built tags");
  // The legacy `src-<fp>` tag was writable from PR jobs before this change, so
  // release must stop consulting it entirely; otherwise an old tag can satisfy
  // the skip-if-unchanged check.
  assert.ok(
    !release.includes("steps.fingerprint.outputs.src_tag"),
    "release must not consult the legacy src tag",
  );
  assert.ok(!/needs\.[\w-]+\.outputs\.src_tag/.test(release), "no job output may forward the legacy tag");
});

test("the V8 builder is pinned and decoupled from BASE_IMAGE", () => {
  const dockerfile = read("deploy/Dockerfile.agent-chrome-fuzz");
  assert.match(
    dockerfile,
    /ARG V8_BUILDER_IMAGE=node:22-bookworm-slim@sha256:[0-9a-f]{64}/,
    "the builder base must be pinned by digest",
  );
  assert.ok(
    dockerfile.includes("FROM --platform=$BUILDPLATFORM ${V8_BUILDER_IMAGE} AS v8-build-rootfs"),
    "the compile stage must use the pinned builder image",
  );
  assert.ok(
    !dockerfile.includes("FROM --platform=$BUILDPLATFORM ${BASE_IMAGE}"),
    "the compile stage must not inherit the mutable base",
  );
  assert.ok(
    dockerfile.includes("FROM ${BASE_IMAGE} AS runtime-rootfs"),
    "the runtime stage must still follow the resolved base",
  );
  // The pinned builder is a bare slim image: it must bootstrap a CA bundle, or
  // the https snapshot sources fail with "certificate is NOT trusted".
  assert.match(dockerfile, /ARG CA_IMAGE=debian:bookworm-slim@sha256:[0-9a-f]{64}/);
  assert.ok(dockerfile.includes("FROM ${CA_IMAGE} AS ca-bootstrap"), "a CA bootstrap stage is required");
  assert.ok(
    dockerfile.includes("COPY --from=ca-bootstrap /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt"),
    "the builder must install the CA bundle before fetching https snapshot sources",
  );
  // The copy must precede the apt snapshot step inside the builder stage.
  const builderBlock = dockerfile.slice(dockerfile.indexOf("AS v8-build-rootfs"), dockerfile.indexOf("FROM ${BASE_IMAGE} AS runtime-rootfs"));
  assert.ok(
    builderBlock.indexOf("COPY --from=ca-bootstrap") < builderBlock.indexOf("snapshot.debian.org"),
    "CA bundle must be copied before the snapshot apt sources are used",
  );

  // The arm64 sysroot is extracted with `tar xf`, which needs xz; the original
  // builder inherited xz-utils/unzip from BASE_IMAGE.
  const builderApt = dockerfile.slice(dockerfile.indexOf("AS v8-build-rootfs"), dockerfile.indexOf("FROM ${BASE_IMAGE} AS runtime-rootfs"));
  assert.match(builderApt, /apt-get install[^;]*\bxz-utils\b/, "the builder must install xz-utils for the arm64 sysroot");
  assert.match(builderApt, /apt-get install[^;]*\bunzip\b/, "the builder must install unzip for depot_tools");

  // The pinned V8 inputs and the preflight copy must survive the split.
  for (const marker of ["ARG V8_COMMIT=", "ARG DEPOT_TOOLS_COMMIT=", "ARG COMPILER_RT_COMMIT=", "chrome-fuzz-toolchain-preflight.sh", "autoninja -C out/release"]) {
    assert.ok(dockerfile.includes(marker), `the builder must keep ${marker}`);
  }
});

test("the runtime-only inputs stay out of the compile stage inputs", () => {
  const dockerfile = read("deploy/Dockerfile.agent-chrome-fuzz");
  // These are consumed only after the compile stage; asserting them here keeps a
  // future refactor from moving them into the pinned builder.
  const builderStage = dockerfile.slice(
    dockerfile.indexOf("AS v8-build-rootfs"),
    dockerfile.indexOf("FROM runtime-rootfs AS runtime-final"),
  );
  assert.ok(!builderStage.includes("chrome-fuzz-runtime.json"), "runtime config must not gate the V8 build");
  assert.ok(!builderStage.includes("runtime-manuals"), "manuals must not gate the V8 build");
});
