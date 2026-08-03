import { strict as assert } from "node:assert";
import { compressedLayerSize, maxCompressedPlatformSize } from "./oci-image-size.mjs";

const amd64Digest = `sha256:${"a".repeat(64)}`;
const arm64Digest = `sha256:${"b".repeat(64)}`;
const attestationDigest = `sha256:${"c".repeat(64)}`;
const root = {
  manifests: [
    { digest: amd64Digest, platform: { os: "linux", architecture: "amd64" } },
    { digest: arm64Digest, platform: { os: "linux", architecture: "arm64", variant: "v8" } },
    { digest: attestationDigest, platform: { os: "unknown", architecture: "unknown" } },
  ],
};
const manifests = new Map([
  [amd64Digest, { layers: [{ size: 100 }, { size: 250 }] }],
  [arm64Digest, { layers: [{ size: 125 }, { size: 300 }] }],
]);

assert.equal(compressedLayerSize({ layers: [{ size: 10 }, { size: 20 }] }), 30);
const result = await maxCompressedPlatformSize(
  root,
  ["linux/amd64", "linux/arm64"],
  async (digest) => manifests.get(digest),
);
assert.deepEqual(result, {
  size_bytes: 425,
  platform_size_bytes: { "linux/amd64": 350, "linux/arm64": 425 },
});
await assert.rejects(
  () => maxCompressedPlatformSize(root, ["linux/s390x"], async () => ({ layers: [] })),
  /OCI index 缺少目标平台: linux\/s390x/,
);
assert.throws(() => compressedLayerSize({ layers: [{ size: -1 }] }), /size 无效/);

console.log("OCI 多架构镜像大小计算通过");
