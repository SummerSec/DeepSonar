#!/usr/bin/env bash
set -euo pipefail

registry_file="deploy/runtime-image-registry.json"
# Chrome specialist keys are intentionally handled by this same immutable
# digest-only path. Their bundled entries stay empty until Release records a
# real amd64/arm64 artifact; no moving browser or d8 tag is pulled here:
# deepsonar-chrome-audit, deepsonar-chrome-test, deepsonar-chrome-fuzz.
temp_file=""
success_count=0
failure_count=0
use_local_file=0

清理() {
  if [[ -n "$temp_file" ]]; then
    rm -f "$temp_file"
  fi
}
trap 清理 EXIT

if [[ "${1:-}" == "--file" ]]; then
  [[ -n "${2:-}" ]] || { echo "用法：$0 --file <注册表 JSON>" >&2; exit 2; }
  registry_file="$2"
  use_local_file=1
elif [[ -n "${1:-}" ]]; then
  echo "用法：$0 [--file <注册表 JSON>]" >&2
  exit 2
fi

if ((use_local_file == 0)) && [[ -n "${DEEPSONAR_URL:-}" ]]; then
  temp_file="$(mktemp)"
  curl_args=(--fail --silent --show-error "${DEEPSONAR_URL%/}/runtime-images/registry")
  if [[ -n "${DEEPSONAR_TOKEN:-}" ]]; then
    curl_args+=(--header "Authorization: Bearer ${DEEPSONAR_TOKEN}")
  fi
  if ! curl "${curl_args[@]}" >"$temp_file"; then
    echo "API 获取失败，退回本地清单：$registry_file" >&2
    rm -f "$temp_file"
    temp_file=""
  fi
fi

registry_path="$registry_file"
if [[ -n "$temp_file" ]]; then
  registry_path="$temp_file"
fi
[[ -f "$registry_path" ]] || { echo "找不到注册表：$registry_path" >&2; exit 1; }

refs_file="$(mktemp)"
if ! node - "$registry_path" >"$refs_file" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const registry = JSON.parse(fs.readFileSync(file, "utf8"));
if (!((registry.schema === "deepsonar.registry/v1" || registry.schema === "deepsonar.registry/v2") && Array.isArray(registry.images))) {
  throw new Error("注册表 schema 无效");
}
const channel = registry.selected_channel || process.env.DEEPSONAR_RUNTIME_REGISTRY_CHANNEL || "aliyun-acr";
if (!["github", "dockerhub", "aliyun-acr"].includes(channel)) throw new Error(`invalid selected channel: ${channel}`);
const platform = process.arch === "x64" ? "linux/amd64" : process.arch === "arm64" ? "linux/arm64" : null;
if (!platform) throw new Error(`unsupported host architecture: ${process.arch}`);
function legacyChannel(imageRef) {
  const host = String(imageRef || "").split("/", 1)[0].toLowerCase();
  if (host === "ghcr.io") return "github";
  if (host === "docker.io" || host === "index.docker.io") return "dockerhub";
  if (host.endsWith(".aliyuncs.com")) return "aliyun-acr";
  return null;
}
function compareVersionLabels(left, right) {
  const tokenize = (value) => String(value).trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const a = tokenize(left);
  const b = tokenize(right);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return av < bv ? -1 : 1;
      continue;
    }
    if (typeof av === "number") return 1;
    if (typeof bv === "number") return -1;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}
// Default: one immutable ref per product (latest version label). Historical
// digests stay in the catalog for pin / Job snapshots but are not bulk-pulled.
for (const image of registry.images) {
  if (!Array.isArray(image.versions)) throw new Error(`${image.image_key} versions 无效`);
  const candidates = [];
  for (const version of image.versions) {
    if (!Array.isArray(version.platforms) || !version.platforms.includes(platform)) continue;
    const imageRef = version.registry_refs?.[channel]
      || (registry.schema === "deepsonar.registry/v1" && legacyChannel(version.image_ref) === channel ? version.image_ref : null);
    if (!imageRef) continue;
    if (!/^.+@sha256:[0-9a-f]{64}$/.test(imageRef)) {
      throw new Error(`${image.image_key} ${version.version} 不是不可变 digest`);
    }
    candidates.push({ ...version, selected_ref: imageRef });
  }
  if (image.versions.length > 0 && !image.versions.some((version) => Array.isArray(version.platforms) && version.platforms.includes(platform))) {
    throw new Error(`${image.image_key} has no version for ${platform}`);
  }
  if (candidates.length === 0 && image.versions.length > 0) {
    throw new Error(`${image.image_key} has no ${channel} reference for ${platform}`);
  }
  if (candidates.length === 0) continue;
  candidates.sort((left, right) => {
    const versionDiff = compareVersionLabels(right.version, left.version);
    if (versionDiff !== 0) return versionDiff;
    return String(right.digest || right.selected_ref).localeCompare(String(left.digest || left.selected_ref));
  });
  process.stdout.write(`${candidates[0].selected_ref}\n`);
}
NODE
then
  rm -f "$refs_file"
  exit 1
fi
mapfile -t image_refs <"$refs_file"
rm -f "$refs_file"

for image_ref in "${image_refs[@]}"; do
  [[ -n "$image_ref" ]] || continue
  if docker pull "$image_ref"; then
    ((success_count+=1))
    echo "拉取成功：$image_ref"
  else
    ((failure_count+=1))
    echo "拉取失败：$image_ref" >&2
  fi
done

echo "汇总：成功 ${success_count} 项，失败 ${failure_count} 项"
if ((failure_count > 0)); then
  exit 1
fi
