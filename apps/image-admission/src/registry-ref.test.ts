import assert from "node:assert/strict";
import test from "node:test";
import { normalizePreferredRegistry, pullAdmissionRuntimeImage, selectAdmissionImageRef } from "./registry-ref.js";
import { RETIRED_RUNTIME_IMAGE_KEYS, RuntimeImageRetiredError } from "@deepsonar/shared-types";

const digest = `sha256:${"a".repeat(64)}`;
const ghcr = `ghcr.io/summersec/deepsonar-base@${digest}`;
const acr = `crpi.example.com/summersec/deepsonar-base@${digest}`;

test("官方周期扫描优先选择部署 registry 的已核验引用", () => {
  assert.equal(selectAdmissionImageRef({
    sourceKind: "official",
    imageKey: "deepsonar-base",
    imageRef: ghcr,
    preferredRegistry: "crpi.example.com/summersec",
    registryRefs: [ghcr, acr],
  }), acr);
});

test("official-digest 直接登记 ACR 时没有 channel refs 也使用主引用", () => {
  assert.equal(selectAdmissionImageRef({
    sourceKind: "official",
    imageKey: "deepsonar-base",
    imageRef: acr,
    preferredRegistry: "crpi.example.com/summersec",
    digest,
    registryRefs: [],
  }), acr);
});

test("官方版本缺少部署 registry ref 时拒绝回退到旧 GHCR", () => {
  assert.throws(() => selectAdmissionImageRef({
    sourceKind: "official",
    imageKey: "deepsonar-base",
    imageRef: ghcr,
    preferredRegistry: "crpi.example.com/summersec",
    digest,
    registryRefs: [],
  }), /没有匹配/);
});

test("官方部署 registry ref 的 digest 不一致时 fail closed", () => {
  assert.throws(() => selectAdmissionImageRef({
    sourceKind: "official",
    imageKey: "deepsonar-base",
    imageRef: ghcr,
    preferredRegistry: "crpi.example.com/summersec",
    digest,
    registryRefs: [`crpi.example.com/summersec/deepsonar-base@sha256:${"b".repeat(64)}`],
  }), /digest 与版本不一致/);
});

test("未配置部署 registry 时保留原始不可变引用", () => {
  assert.equal(selectAdmissionImageRef({
    sourceKind: "official",
    imageKey: "deepsonar-base",
    imageRef: ghcr,
    preferredRegistry: "",
    registryRefs: [ghcr],
  }), ghcr);
});

test("第三方镜像不受官方 registry 选源影响", () => {
  const thirdParty = "registry.example.com/vendor/tool@" + digest;
  assert.equal(selectAdmissionImageRef({
    sourceKind: "third_party",
    imageKey: "vendor-tool",
    imageRef: thirdParty,
    preferredRegistry: "crpi.example.com/summersec",
  }), thirdParty);
});

test("部署 registry 配置拒绝 URL 形式", () => {
  assert.throws(() => normalizePreferredRegistry("https://crpi.example.com/summersec"), /基址/);
});

test("retired queued scans and tracked tags never reach the external pull boundary", async () => {
  const pulled: string[] = [];
  for (const key of RETIRED_RUNTIME_IMAGE_KEYS) {
    for (const sourceKind of ["official", "third_party"]) {
      assert.throws(() => selectAdmissionImageRef({ sourceKind, imageKey: key, imageRef: ghcr }), RuntimeImageRetiredError);
    }
    await assert.rejects(pullAdmissionRuntimeImage(key, ghcr, async (ref) => { pulled.push(ref); }),
      (error: unknown) => error instanceof RuntimeImageRetiredError && error.code === "RUNTIME_IMAGE_RETIRED");
    assert.deepEqual(pulled, []);
  }
  await pullAdmissionRuntimeImage("deepsonar-clickhouse-audit-custom", ghcr, async (ref) => { pulled.push(ref); });
  assert.deepEqual(pulled, [ghcr], "lookalikes remain legitimate products");
});
