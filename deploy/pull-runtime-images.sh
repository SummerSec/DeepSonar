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

mapfile -t image_refs < <(node - "$registry_path" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const registry = JSON.parse(fs.readFileSync(file, "utf8"));
if (!((registry.schema === "deepsonar.registry/v1" || registry.schema === "deepsonar.registry/v2") && Array.isArray(registry.images))) {
  throw new Error("注册表 schema 无效");
}
for (const image of registry.images) {
  if (!Array.isArray(image.versions)) throw new Error(`${image.image_key} versions 无效`);
  for (const version of image.versions) {
    // v2's legacy projection is explicit. Channel-only Docker Hub/ACR
    // versions are skipped until channel-aware pull selection exists.
    if (registry.schema === "deepsonar.registry/v2" && !version.image_ref) continue;
    if (!/^.+@sha256:[0-9a-f]{64}$/.test(version.image_ref)) {
      throw new Error(`${image.image_key} ${version.version} 不是不可变 digest`);
    }
    process.stdout.write(`${version.image_ref}\n`);
  }
}
NODE
)

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
