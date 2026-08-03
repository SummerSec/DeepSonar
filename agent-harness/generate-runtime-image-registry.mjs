import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const registryPath = checkOnly ? args[1] : args[1];
if (!registryPath) throw new Error("用法：生成 <清单目录> <输出文件>；校验 --check <清单文件>");

const parse = (path) => JSON.parse(readFileSync(path, "utf8"));
const assertRegistry = (registry) => {
  if (registry.schema !== "deepsonar.registry/v1" || !Array.isArray(registry.images)) {
    throw new Error("runtime-image-registry.json schema 无效");
  }
  const expected = ["deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal", "deepsonar-openharmony-test"];
  const images = new Map(registry.images.map((image) => [image.image_key, image]));
  if (images.size !== expected.length || expected.some((key) => !images.has(key))) {
    throw new Error("runtime-image-registry.json 必须包含四项官方运行时镜像");
  }
  for (const key of expected) {
    const versions = images.get(key).versions;
    if (!Array.isArray(versions) || versions.length !== 1) throw new Error(`${key} 必须恰好包含一个发布版本`);
    const version = versions[0];
    if (!/^v?\d+\.\d+\.\d+$/.test(version.version)) throw new Error(`${key} 版本号无效`);
    if (!/^ghcr\.io\/[^/]+\/deepsonar-[^@]+@sha256:[0-9a-f]{64}$/.test(version.image_ref) &&
        !/^[^/]+\/[^/]+\/deepsonar-[^@]+@sha256:[0-9a-f]{64}$/.test(version.image_ref)) {
      throw new Error(`${key} image_ref 必须是不可变 manifest digest`);
    }
    if (!Array.isArray(version.platforms) || version.platforms.length === 0) throw new Error(`${key} platforms 无效`);
    if (!Number.isSafeInteger(version.size_bytes) || version.size_bytes <= 0) throw new Error(`${key} size_bytes 无效`);
  }
};

if (checkOnly) {
  assertRegistry(parse(registryPath));
  console.log(`发布清单校验通过：${registryPath}`);
} else {
  const descriptorDir = args[0];
  const outputPath = args[1];
  const template = parse(new URL("../deploy/runtime-image-registry.json", import.meta.url));
  const expected = ["deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal", "deepsonar-openharmony-test"];
  const descriptors = new Map();
  for (const key of expected) {
    const descriptor = parse(`${descriptorDir}/${key.replace("deepsonar-", "")}.json`);
    if (descriptor.image_key !== key) throw new Error(`${key} digest 清单键不匹配`);
    if (!/^sha256:[0-9a-f]{64}$/.test(descriptor.digest)) throw new Error(`${key} digest 无效`);
    descriptors.set(key, descriptor);
  }
  const acrConfigured = ["ALIYUN_REGISTRY", "ALIYUN_REGISTRY_NAMESPACE", "ALIYUN_REGISTRY_USERNAME", "ALIYUN_REGISTRY_PASSWORD"]
    .every((name) => Boolean(process.env[name]));
  const images = template.images.filter((image) => expected.includes(image.image_key)).map((image) => {
    const descriptor = descriptors.get(image.image_key);
    const imageRef = acrConfigured ? descriptor.acr_ref : descriptor.ghcr_ref;
    if (!imageRef) throw new Error(`${image.image_key} 缺少目标 registry 引用`);
    return {
      ...image,
      versions: [{
        version: process.env.VERSION,
        image_ref: imageRef,
        platforms: descriptor.platforms,
        size_bytes: descriptor.size_bytes,
      }],
    };
  });
  const registry = { schema: "deepsonar.registry/v1", images };
  assertRegistry(registry);
  writeFileSync(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`已生成发布清单：${outputPath}（${acrConfigured ? "ACR" : "GHCR"}）`);
}
