import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

const descriptor = {
  image_key: process.env.IMAGE_KEY,
  version: process.env.VERSION,
  digest: process.env.DIGEST,
  platforms,
  ghcr_ref: `${process.env.GHCR_REF}@${process.env.DIGEST}`,
};
if (process.env.ACR_CONFIGURED === "true") {
  if (!process.env.ACR_REF) throw new Error("ACR 已配置但缺少 ACR_REF");
  descriptor.acr_ref = `${process.env.ACR_REF}@${process.env.DIGEST}`;
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(descriptor, null, 2)}\n`);
