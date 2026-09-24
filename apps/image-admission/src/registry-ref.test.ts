import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { normalizePreferredRegistry, selectAdmissionImageRef } from "./registry-ref.js";

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

/**
 * #699（Schema v55）从 project_runtime_images 删除了 selected_version_id / pin_policy，
 * 改为「项目只能排除或启用镜像，不再固定版本」。image-admission 的两条「在用版本」查询
 * 漏改，仍引用该列，导致 v55 起进程启动即崩（PostgreSQL 42703 undefined_column，
 * 生产实测重启 1228 次）。
 *
 * 该守卫放在本文件而不是独立测试文件，是因为 ci-test-hook 棘轮只承认源码路径引用，
 * 且 allowlist 只允许缩小；本文件已在 test:registry-ref 中随 CI 执行。
 */
test("image-admission 不引用 v55 已删除的 project_runtime_images 列", () => {
  // 从 dist 或源码位置均可执行：优先源码，回退同目录产物。
  const sourceUrl = ["../src/index.ts", "./index.ts"]
    .map((candidate) => new URL(candidate, import.meta.url))
    .find((url) => existsSync(url));
  assert.ok(sourceUrl, "找不到 image-admission 的 index.ts");
  const source = readFileSync(sourceUrl, "utf8");
  for (const dropped of ["selected_version_id", "pin_policy"]) {
    assert.equal(
      source.includes(`p.${dropped}`),
      false,
      `image-admission 仍引用已删除的 project_runtime_images.${dropped}（#699 起「在用版本」改由 v.promoted_at 与 Job 快照引用判定）`,
    );
  }
});
