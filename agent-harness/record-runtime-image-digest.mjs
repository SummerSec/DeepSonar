import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inspectPublishedImageSize } from "./oci-image-size.mjs";

const output = process.argv[2];
if (!output) throw new Error("用法：node record-runtime-image-digest.mjs <输出文件>");

const required = ["IMAGE_KEY", "DIGEST", "PLATFORMS", "GHCR_REF", "VERSION"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`缺少环境变量：${name}`);
}
if (!/^sha256:[0-9a-f]{64}$/.test(process.env.DIGEST)) {
  throw new Error(`build-push-action digest 无效：${process.env.DIGEST}`);
}

const platforms = process.env.PLATFORMS.split(",").map((platform) => platform.trim()).filter(Boolean);
if (platforms.length === 0) throw new Error("必须记录至少一个发布平台");

const ghcrRef = `${process.env.GHCR_REF}@${process.env.DIGEST}`;
const size = await inspectPublishedImageSize(ghcrRef, platforms);

const descriptor = {
  image_key: process.env.IMAGE_KEY,
  version: process.env.VERSION,
  digest: process.env.DIGEST,
  platforms,
  ghcr_ref: ghcrRef,
  size_bytes: size.size_bytes,
  platform_size_bytes: size.platform_size_bytes,
  // 多架构 index 下各平台 child manifest digest；生成清单时一平台一版本
  platform_digests: size.platform_digests ?? {},
};
if (process.env.ACR_CONFIGURED === "true") {
  if (!process.env.ACR_REF) throw new Error("ACR 已配置但缺少 ACR_REF");
  descriptor.acr_ref = `${process.env.ACR_REF}@${process.env.DIGEST}`;
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(descriptor, null, 2)}\n`);
