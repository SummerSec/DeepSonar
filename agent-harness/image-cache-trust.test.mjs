// #961 P2/P3: the V8 compile stage must not inherit BASE_IMAGE, and PR/CI
// builds must not be able to satisfy the release skip-if-unchanged check.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { computeFingerprint } from "./image-build-fingerprint.mjs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const CI_WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/chrome-runtime.yml",
  ".github/workflows/mobile-runtime.yml",
  ".github/workflows/openharmony-runtime.yml",
];

const CACHE_LOAD_STEPS = [
  [CI_WORKFLOWS[0], "Load reused runtime for offline validation", "base", "amd64", false],
  [CI_WORKFLOWS[1], "Pull reused image for smoke", "chrome", "amd64", false],
  ...["amd64", "arm64"].flatMap(arch => [
    [CI_WORKFLOWS[2], "Pull reused Mobile image for manual validation", "mobile", arch, true],
    [CI_WORKFLOWS[3], "Pull reused OpenHarmony image for manual validation", "openharmony", arch, true],
  ]),
];

function cacheLoadFixture(t, file, name, toolset, arch) {
  const directory = mkdtempSync(join(tmpdir(), "deepsonar-cache-load-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const resolvedDigest = `sha256:${"a".repeat(64)}`;
  const movedDigest = `sha256:${"b".repeat(64)}`;
  const image = `ghcr.io/fixture/deepsonar-${toolset}`;
  const log = join(directory, "docker.log");
  const loaded = join(directory, "loaded");
  const tagged = join(directory, "tagged");
  writeFileSync(join(directory, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.slice(0, 3).join(" ") === "buildx imagetools inspect") {
  console.log(process.env.RESOLVED_DIGEST);
  process.exit(0);
}
fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "pull") {
  if (process.env.PULL_FAIL === "1") process.exit(7);
  // The tag has moved since resolve; digest-addressed reads retain the original.
  const reference = args.at(-1);
  fs.writeFileSync(process.env.LOADED, reference.includes("@") ? reference.split("@")[1] : process.env.MOVED_DIGEST);
} else if (args[0] === "tag") {
  fs.copyFileSync(process.env.LOADED, process.env.TAGGED);
} else if (args[0] !== "image" || args[1] !== "inspect") {
  process.exit(8);
}
`, { mode: 0o755 });
  const output = join(directory, "output");
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, IMAGE_NAME: image,
    FINGERPRINT: "fixture", SRC_TAG: "src-ci-fixture", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "",
    RESOLVED_DIGEST: resolvedDigest, MOVED_DIGEST: movedDigest, DOCKER_LOG: log, LOADED: loaded, TAGGED: tagged };
  const resolveResult = spawnSync("bash", [fileURLToPath(new URL("./resolve-image-src-cache.sh", import.meta.url)), "resolve"], { env, encoding: "utf8" });
  assert.equal(resolveResult.status, 0, resolveResult.stderr);
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  assert.equal(outputs.skip, "true");
  assert.equal(outputs.digest, resolvedDigest);
  const marker = `      - name: ${name}\n`;
  const body = read(file);
  assert.equal(body.split(marker).length, 2, `${file}: unique cache-load step`);
  const step = body.split(marker)[1].split("\n      - ")[0];
  assert.ok(step.includes("steps.resolve.outputs.skip == 'true'"));
  const script = step.split("        run: |\n")[1];
  assert.ok(script, `${file}: actual shell body required`);
  const sourceExpression = step.match(/^\s{10}SOURCE_IMAGE: (.*)$/m)?.[1] ?? "";
  const execute = (digest = outputs.digest, extraEnv = {}) => {
    const values = { "steps.ns.outputs.owner": "fixture", "matrix.toolset": toolset,
      "matrix.arch": arch, "matrix.platform": `linux/${arch}`,
      "steps.resolve.outputs.digest": digest, "steps.resolve.outputs.src_ref": outputs.src_ref, "steps.resolve.outputs.source_image": `${image}@${digest}` };
    const render = text => text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
      assert.ok(Object.hasOwn(values, key), `unknown workflow expression: ${key}`);
      return values[key];
    });
    return spawnSync("bash", ["-c", render(script)], {
      env: { ...env, SOURCE_IMAGE: render(sourceExpression), ...extraEnv }, encoding: "utf8",
    });
  };
  return { execute, resolvedDigest, tagged, commands: () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

for (const [file, step, toolset, arch, explicitPlatform] of CACHE_LOAD_STEPS) {
  test(`#992 ${toolset}/${arch}: actual cache-load shell stays on resolved digest after tag moves`, t => {
    const fixture = cacheLoadFixture(t, file, step, toolset, arch);
    const result = fixture.execute();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.tagged, "utf8"), fixture.resolvedDigest);
    const commands = fixture.commands();
    const source = `ghcr.io/fixture/deepsonar-${toolset}@${fixture.resolvedDigest}`;
    assert.deepEqual(commands[0], explicitPlatform ? ["pull", "--platform", `linux/${arch}`, source] : ["pull", source]);
    assert.deepEqual(commands[1], ["tag", source, `deepsonar-${toolset}:${explicitPlatform ? `${arch}-ci` : "ci"}`]);
    assert.equal(commands.length, toolset === "base" ? 3 : 2);
  });

  test(`#992 ${toolset}/${arch}: missing or malformed resolved digest never calls Docker`, t => {
    const fixture = cacheLoadFixture(t, file, step, toolset, arch);
    for (const digest of ["", "sha256:bad", `sha512:${"a".repeat(64)}`, `${fixture.resolvedDigest}\n`, `${fixture.resolvedDigest}extra`]) {
      const result = fixture.execute(digest);
      assert.equal(result.status, 1, `digest ${JSON.stringify(digest)} must fail before Docker`);
      assert.deepEqual(fixture.commands(), []);
      assert.equal(existsSync(fixture.tagged), false);
    }
  });

  test(`#992 ${toolset}/${arch}: digest pull failure never falls back to tag or builds`, t => {
    const fixture = cacheLoadFixture(t, file, step, toolset, arch);
    assert.equal(fixture.execute(undefined, { PULL_FAIL: "1" }).status, 7);
    assert.equal(fixture.commands().length, 1);
    assert.equal(fixture.commands()[0][0], "pull");
    assert.equal(existsSync(fixture.tagged), false);
  });
}

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
