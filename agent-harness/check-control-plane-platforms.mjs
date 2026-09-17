/**
 * Static gate for control-plane multi-arch publish (#598).
 * Does not call registries (no flaky network). Verifies:
 * - control-plane Node Dockerfiles share one node:24-alpine@sha256 pin
 * - that pin is not the known amd64-only digest that blocked arm64
 * - scheduler still handles TARGETARCH kubectl (amd64 + arm64 shas)
 * - release.yml matrix lists linux/amd64,linux/arm64 for control-plane + republish images
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

/** Historical pin that only carried linux/amd64 (plus attestation) — must not regress. */
const AMD64_ONLY_NODE_DIGEST =
  "sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114";

const NODE_FROM_RE =
  /FROM\s+node:24-alpine@(sha256:[a-f0-9]{64})(?:\s+AS\s+\w+)?/g;

const controlPlaneDockerfiles = [
  "deploy/Dockerfile.scheduler",
  "deploy/Dockerfile.web",
  "deploy/Dockerfile.image-admission",
  "deploy/Dockerfile.device-broker",
];

const digests = [];
for (const rel of controlPlaneDockerfiles) {
  const source = read(rel);
  const found = [...source.matchAll(NODE_FROM_RE)].map((m) => m[1]);
  assert.ok(found.length >= 1, `${rel} must pin node:24-alpine@sha256`);
  for (const d of found) {
    assert.notEqual(
      d,
      AMD64_ONLY_NODE_DIGEST,
      `${rel} must not use amd64-only node digest ${AMD64_ONLY_NODE_DIGEST} (#598)`,
    );
    digests.push(d);
  }
}
assert.equal(
  new Set(digests).size,
  1,
  `control-plane Dockerfiles must share one node:24-alpine digest; got ${[...new Set(digests)].join(", ")}`,
);

const scheduler = read("deploy/Dockerfile.scheduler");
assert.match(scheduler, /ARG TARGETARCH=amd64/, "scheduler must declare TARGETARCH");
assert.match(
  scheduler,
  /elif \[ "\$arch" = "arm64" \]; then sha=[a-f0-9]{64}/,
  "scheduler must pin kubectl arm64 sha for TARGETARCH=arm64",
);
assert.match(
  scheduler,
  /if \[ "\$arch" = "amd64" \]; then sha=[a-f0-9]{64}/,
  "scheduler must pin kubectl amd64 sha",
);

const release = read(".github/workflows/release.yml");
const requiredMatrix = [
  "scheduler",
  "web",
  "image-admission",
  "assets-helper",
  "silo",
];
for (const name of requiredMatrix) {
  const re = new RegExp(
    String.raw`name:\s*${name},[^}\n]*platforms:\s*"([^"]+)"`,
  );
  const m = release.match(re);
  assert.ok(m, `release.yml images matrix missing entry for ${name}`);
  const platforms = m[1].split(",").map((p) => p.trim());
  assert.ok(
    platforms.includes("linux/amd64") && platforms.includes("linux/arm64"),
    `release.yml ${name} platforms must include linux/amd64 and linux/arm64; got ${m[1]}`,
  );
}

console.log(
  `control-plane platforms ok: node digest=${digests[0]}; release matrix amd64+arm64 for ${requiredMatrix.join(", ")}`,
);
