#!/usr/bin/env bash
# 后台准备四个内置运行时镜像。
# 默认不执行 git pull；设置 DEEPSONAR_RUNTIME_IMAGE_GIT_PULL=true 后，只有 clean
# worktree 才会执行 git pull --ff-only，dirty worktree 会记录跳过，不会 stash/reset/merge。
# 本脚本默认只检测本地构建的官方镜像；只有显式传入 --adopt 才会请求
# Scheduler 将通过门禁的候选登记为 local-docker 专用 trusted 版本。使用 --dry-run 或设置
# DEEPSONAR_RUNTIME_IMAGE_BUILD=false 可只检查流程而不执行真实构建。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/data/logs"
REGISTRY_FILE="$ROOT/deploy/runtime-image-registry.json"
PULL_SCRIPT="$ROOT/deploy/pull-runtime-images.sh"
FORCE_REFRESH="${DEEPSONAR_RUNTIME_IMAGE_FORCE_REFRESH:-false}"
BUILD_ENABLED="${DEEPSONAR_RUNTIME_IMAGE_BUILD:-true}"
DRY_RUN=false
ADOPT_LOCAL=false
SUCCESS_COUNT=0
FAILURE_COUNT=0
SKIP_COUNT=0
FAILURES=()
TEMP_REGISTRY=""
TEMP_REGISTRY_IS_TEMP=false
API_ROOT=""
API_TOKEN="${DEEPSONAR_TOKEN:-}"
LOCK_DIR="$ROOT/data/run/runtime-images.prepare.lock"
LOCK_ACQUIRED=false

log() { printf '[runtime-images] %s\n' "$*"; }
fail_item() { FAILURE_COUNT=$((FAILURE_COUNT + 1)); FAILURES+=("$1"); log "失败：$1"; }
cleanup() {
  if [[ "$TEMP_REGISTRY_IS_TEMP" == true && -n "$TEMP_REGISTRY" ]]; then
    rm -f "$TEMP_REGISTRY"
  fi
  if [[ "$LOCK_ACQUIRED" == true ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
用法：deploy/prepare-runtime-images.sh [--dry-run] [--adopt]

默认只读取 API/静态 registry，不执行 git pull。设置
DEEPSONAR_RUNTIME_IMAGE_GIT_PULL=true 后，仅当 worktree clean 时执行
git pull --ff-only；dirty worktree 只记录跳过，绝不 stash/reset/merge。
设置 DEEPSONAR_RUNTIME_IMAGE_BUILD=false 或使用 --dry-run 可禁用真实 docker 构建。
默认只检测本地 image ID、契约和产品标签，不改变 trust；--adopt 是运维显式授权，
仅把通过门禁的官方候选登记为 local-docker 专用 trusted 版本，不会导出到 registry。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --adopt) ADOPT_LOCAL=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

mkdir -p "$LOG_DIR"
cd "$ROOT"
mkdir -p "$ROOT/data/run"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "已有运行时镜像准备任务正在执行，跳过本次启动"
  exit 0
fi
LOCK_ACQUIRED=true

if [[ "${DEEPSONAR_RUNTIME_IMAGE_GIT_PULL:-false}" == "true" ]]; then
  if [[ -z "$(git status --porcelain)" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      log "dry-run：worktree clean，跳过 git pull --ff-only 实际执行"
    elif git pull --ff-only; then
      log "已完成 git pull --ff-only"
    else
      log "git pull --ff-only 失败，继续准备镜像；未执行 stash/reset/merge"
    fi
  else
    log "检测到 dirty worktree，跳过 git pull；不会 stash/reset/merge"
  fi
else
  log "默认不执行 git pull；如需显式更新，请设置 DEEPSONAR_RUNTIME_IMAGE_GIT_PULL=true"
fi

load_api_token() {
  [[ -n "$API_TOKEN" ]] && return 0
  API_TOKEN="$(node - "$ROOT/.env" "$ROOT/deploy/.env" <<'NODE'
const fs = require("node:fs");
for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) continue;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = raw.match(/^\s*DEEPSONAR_ADMIN_TOKEN\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.stdout.write(value);
    process.exit(0);
  }
}
NODE
)"
}

load_registry() {
  local url="${DEEPSONAR_URL:-http://127.0.0.1:3100}"
  if command -v curl >/dev/null 2>&1; then
    local -a roots=("${url%/}")
    [[ "${url%/}" == */api ]] || roots+=("${url%/}/api")
    load_api_token
    for root in "${roots[@]}"; do
      TEMP_REGISTRY="$(mktemp)"
      TEMP_REGISTRY_IS_TEMP=true
      local -a curl_args=(--fail --silent --show-error --connect-timeout 3 --max-time 10 "$root/runtime-images/registry")
      [[ -z "$API_TOKEN" ]] || curl_args+=(--header "Authorization: Bearer $API_TOKEN")
      if curl "${curl_args[@]}" >"$TEMP_REGISTRY"; then
        API_ROOT="$root"
        log "已从 API 读取运行时镜像注册表：$root"
        return 0
      fi
      rm -f "$TEMP_REGISTRY"
      TEMP_REGISTRY=""
      TEMP_REGISTRY_IS_TEMP=false
    done
  fi
  if [[ -f "$REGISTRY_FILE" ]]; then
    TEMP_REGISTRY="$REGISTRY_FILE"
    TEMP_REGISTRY_IS_TEMP=false
    log "API 不可用，退回静态注册表：$REGISTRY_FILE"
    return 0
  fi
  log "找不到 API 或静态运行时镜像注册表"
  return 1
}

registry_version_keys() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!((registry.schema === "deepsonar.registry/v1" || registry.schema === "deepsonar.registry/v2") && Array.isArray(registry.images))) {
  throw new Error("注册表 schema 无效");
}
const builtinKeys = new Set([
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
  "deepsonar-chrome-audit",
  "deepsonar-chrome-test",
  "deepsonar-chrome-fuzz",
]);
const keys = new Set();
for (const image of registry.images) {
  if (!Array.isArray(image.versions)) throw new Error(`${image.image_key} versions 无效`);
  if (image.versions.length > 0 && builtinKeys.has(image.image_key)) keys.add(image.image_key);
}
process.stdout.write([...keys].join("\n"));
NODE
}

registry_for_key() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const key = process.argv[3];
const image = registry.images.find((item) => item.image_key === key);
if (!image) throw new Error(`注册表缺少 ${key}`);
process.stdout.write(JSON.stringify({ ...registry, images: [image] }));
NODE
}

registry_first_ref() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const image = registry.images.find((item) => item.image_key === process.argv[3]);
const channel = registry.selected_channel || process.env.DEEPSONAR_RUNTIME_REGISTRY_CHANNEL || "aliyun-acr";
const platform = process.arch === "x64" ? "linux/amd64" : process.arch === "arm64" ? "linux/arm64" : null;
function legacyChannel(imageRef) {
  const host = String(imageRef || "").split("/", 1)[0].toLowerCase();
  if (host === "ghcr.io") return "github";
  if (host === "docker.io" || host === "index.docker.io") return "dockerhub";
  if (host.endsWith(".aliyuncs.com")) return "aliyun-acr";
  return null;
}
const versions = image?.versions?.filter((version) => platform && version.platforms?.includes(platform)
  && (typeof version.registry_refs?.[channel] === "string"
    || (registry.schema === "deepsonar.registry/v1" && legacyChannel(version.image_ref) === channel))) ?? [];
versions.sort((left, right) => String(right.version).localeCompare(String(left.version), undefined, { numeric: true }));
const ref = versions[0]?.registry_refs?.[channel] || versions[0]?.image_ref;
if (ref) process.stdout.write(ref);
NODE
}

has_version_key() {
  local key="$1"
  for version_key in "${VERSION_KEYS[@]}"; do
    [[ "$version_key" == "$key" ]] && return 0
  done
  return 1
}

build_one() {
  local name="$1" key="$2" tag="$3" dockerfile="$4" toolset="${5:-}" base_image="${6:-}"
  if [[ "$FORCE_REFRESH" != true ]] && docker image inspect "$tag" >/dev/null 2>&1; then
    SKIP_COUNT=$((SKIP_COUNT + 1)); log "已存在，跳过构建：$tag"
  elif [[ "$DRY_RUN" == true || "$BUILD_ENABLED" != true ]]; then
    log "模拟构建：$name -> $tag"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1)); return 0
  else
    log "开始构建：$name -> $tag"
    local -a args=(docker build --file "$dockerfile" --tag "$tag")
    [[ -z "$toolset" ]] || args+=(--build-arg "TOOLSET=$toolset")
    [[ -z "$base_image" ]] || args+=(--build-arg "BASE_IMAGE=$base_image")
    args+=(.)
    if "${args[@]}"; then
      SUCCESS_COUNT=$((SUCCESS_COUNT + 1)); log "构建成功：$tag"
    else
      fail_item "$name（$tag）"; return 0
    fi
  fi

  local image_id
  if ! image_id="$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null)" || [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail_item "$name（无法取得完整本地 image ID）"
    return 0
  fi
  detect_local "$name" "$key" "$tag" "$image_id"
}

detect_local() {
  local name="$1" key="$2" image_ref="$3" image_id="$4" listing response status product_id candidate_fields adoptable detected_id
  [[ -n "$API_ROOT" ]] || { fail_item "$name（API 不可用，无法检测本地 image ID）"; return 0; }
  listing="$(mktemp)"
  local -a curl_args=(--fail --silent --show-error --connect-timeout 3 --max-time 10 "$API_ROOT/runtime-images")
  [[ -z "$API_TOKEN" ]] || curl_args+=(--header "Authorization: Bearer $API_TOKEN")
  if ! curl "${curl_args[@]}" >"$listing"; then
    rm -f "$listing"; fail_item "$name（读取 /runtime-images 失败）"; return 0
  fi
  product_id="$(node - "$listing" "$key" <<'NODE'
const fs = require("node:fs");
const [file, key] = process.argv.slice(2);
const item = JSON.parse(fs.readFileSync(file, "utf8")).find((row) => row.image_key === key && row.official === true);
if (item?.id) process.stdout.write(item.id);
NODE
)"
  rm -f "$listing"
  if [[ -z "$product_id" ]]; then
    fail_item "$name（API 缺少官方镜像条目）"; return 0
  fi
  response="$(mktemp)"
  local -a post_args=(--silent --show-error --connect-timeout 3 --max-time 15 -o "$response" -w '%{http_code}'
    -H 'Content-Type: application/json' --data "$(printf '{\"image_ref\":\"%s\"}' "$image_ref")")
  [[ -z "$API_TOKEN" ]] || post_args+=(--header "Authorization: Bearer $API_TOKEN")
  status="$(curl "${post_args[@]}" "$API_ROOT/runtime-images/$product_id/detect-local" || true)"
  if [[ "$status" != 2* ]]; then
    rm -f "$response"
    if [[ "$status" == "401" || "$status" == "403" ]] && [[ -z "$API_TOKEN" ]]; then
      fail_item "$name（API 要求鉴权，请设置 DEEPSONAR_TOKEN 或 .env 中的 DEEPSONAR_ADMIN_TOKEN）"
    else
      fail_item "$name（本地镜像检测失败，HTTP ${status:-未知}）"
    fi
    return 0
  fi
  candidate_fields="$(node - "$response" <<'NODE'
const fs = require("node:fs");
const candidate = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(`${candidate.adoptable === true}\t${candidate.image_id ?? ""}`);
NODE
)"
  IFS=$'\t' read -r adoptable detected_id <<<"$candidate_fields"
  rm -f "$response"
  if [[ "$detected_id" != "$image_id" ]]; then
    fail_item "$name（检测后的 image ID 与构建结果不一致）"
    return 0
  fi
  if [[ "$adoptable" != "true" ]]; then
    fail_item "$name（本地镜像未通过 contract / product / tool-manifest 门禁）"
    return 0
  fi
  log "已检测 $name 的 adoptable 本地候选：${image_id:0:19}；尚未改变 trust"
  if [[ "$ADOPT_LOCAL" != true ]]; then
    return 0
  fi
  response="$(mktemp)"
  post_args=(--silent --show-error --connect-timeout 3 --max-time 15 -o "$response" -w '%{http_code}'
    -H 'Content-Type: application/json' --data "$(printf '{\"image_ref\":\"%s\",\"expected_image_id\":\"%s\"}' "$image_ref" "$image_id")")
  [[ -z "$API_TOKEN" ]] || post_args+=(--header "Authorization: Bearer $API_TOKEN")
  status="$(curl "${post_args[@]}" "$API_ROOT/runtime-images/$product_id/adopt-local" || true)"
  if [[ "$status" == 2* ]]; then
    log "已显式采用 $name 为 trusted local 版本：${image_id:0:19}"
  else
    fail_item "$name（本地 trusted 采用失败，HTTP ${status:-未知}）"
  fi
  rm -f "$response"
}

if ! load_registry; then
  fail_item "读取注册表"
  exit 1
fi

VERSION_KEYS_FILE="$(mktemp)"
if ! registry_version_keys "$TEMP_REGISTRY" >"$VERSION_KEYS_FILE"; then
  rm -f "$VERSION_KEYS_FILE"
  fail_item "解析注册表"
  exit 1
fi

mapfile -t VERSION_KEYS <"$VERSION_KEYS_FILE"
rm -f "$VERSION_KEYS_FILE"

prepare_builtin() {
  local name="$1" key="$2" tag="$3" dockerfile="$4" toolset="${5:-}" base_image="${6:-}"
  local pull_file=""
  if has_version_key "$key" && [[ "$DRY_RUN" == false && "$BUILD_ENABLED" == true && -x "$PULL_SCRIPT" ]]; then
    pull_file="$(mktemp)"
    if registry_for_key "$TEMP_REGISTRY" "$key" >"$pull_file" \
      && DEEPSONAR_URL="" "$PULL_SCRIPT" --file "$pull_file"; then
      local pulled_ref
      pulled_ref="$(registry_first_ref "$TEMP_REGISTRY" "$key")"
      if [[ -z "$pulled_ref" ]] || ! docker tag "$pulled_ref" "$tag"; then
        rm -f "$pull_file"
        fail_item "$name（无法为选定 channel 的 digest 建立本地标签）"
        return 0
      fi
      rm -f "$pull_file"
      log "已为 $name 建立本地构建标签：$tag"
      log "已拉取 $name 的不可变 registry 版本"
      return 0
    fi
    rm -f "$pull_file"
    fail_item "$name（选定 channel 的 registry 拉取失败）"
    return 0
  elif has_version_key "$key"; then
    log "$name 存在不可变版本；dry-run/禁用构建模式不拉取，执行模拟构建"
  else
    log "$name 没有不可变版本，执行本地构建"
  fi
  build_one "$name" "$key" "$tag" "$dockerfile" "$toolset" "$base_image"
}

prepare_builtin "base" "deepsonar-base" "deepsonar-base:local" "$ROOT/deploy/Dockerfile.agent" base
prepare_builtin "audit" "deepsonar-audit" "deepsonar-audit:local" "$ROOT/deploy/Dockerfile.agent" audit
prepare_builtin "kali-minimal" "deepsonar-kali-minimal" "deepsonar-kali-minimal:local" "$ROOT/deploy/Dockerfile.agent-kali-minimal"
prepare_builtin "openharmony-test" "deepsonar-openharmony-test" "deepsonar-openharmony-test:local" "$ROOT/deploy/Dockerfile.agent-openharmony" "" "deepsonar-base:local"
prepare_builtin "openharmony-audit" "deepsonar-openharmony-audit" "deepsonar-openharmony-audit:local" "$ROOT/deploy/Dockerfile.agent-openharmony-audit" "" "deepsonar-base:local"
prepare_builtin "openharmony-fuzz" "deepsonar-openharmony-fuzz" "deepsonar-openharmony-fuzz:local" "$ROOT/deploy/Dockerfile.agent-openharmony-fuzz" "" "deepsonar-base:local"
prepare_builtin "chrome-audit" "deepsonar-chrome-audit" "deepsonar-chrome-audit:local" "$ROOT/deploy/Dockerfile.agent-chrome-audit" "" "deepsonar-base:local"
prepare_builtin "chrome-test" "deepsonar-chrome-test" "deepsonar-chrome-test:local" "$ROOT/deploy/Dockerfile.agent-chrome-test" "" "deepsonar-base:local"
prepare_builtin "chrome-fuzz" "deepsonar-chrome-fuzz" "deepsonar-chrome-fuzz:local" "$ROOT/deploy/Dockerfile.agent-chrome-fuzz" "" "deepsonar-base:local"

log "汇总：成功/模拟 ${SUCCESS_COUNT}，跳过 ${SKIP_COUNT}，失败 ${FAILURE_COUNT}"
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  log "失败项目：${FAILURES[*]}"
  log "部分本地镜像未登记成功；请检查失败项目后重试"
  exit 1
fi
if [[ "$ADOPT_LOCAL" == true ]]; then
  log "准备流程完成；显式采用的本地 trusted 版本不会进入 registry 导出清单"
else
  log "准备流程完成；默认仅检测本地候选，未改变 trust（如需授权请显式传 --adopt）"
fi
