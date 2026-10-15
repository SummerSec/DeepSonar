#!/usr/bin/env sh
set -eu

ACTION="${1:-up}"
MODE="${2:-real}"
SOURCE="${3:-pull}"
# Remember which deploy-tuning vars the caller exported (beat .env / defaults).
[ -n "${DEEPSONAR_COMPOSE_DEPENDS_ON+x}" ] && DEEPSONAR_COMPOSE_DEPENDS_ON_SET=1 || true
[ -n "${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC+x}" ] && DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC_SET=1 || true
[ -n "${DEEPSONAR_READY_TIMEOUT_SEC+x}" ] && DEEPSONAR_READY_TIMEOUT_SEC_SET=1 || true
CONTROL_PLANE="${DEEPSONAR_CONTROL_PLANE:-}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
MASTER_KEY_FILE="$SCRIPT_DIR/master.key"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.prod.yml"
REAL_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.real.yml"
OPENSANDBOX_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.opensandbox.prod.yml"
WORKER_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.worker.yml"
PODMAN_COMPAT_FILE="$SCRIPT_DIR/docker-compose.podman-compat.yml"
PODMAN_COMPAT_OS_FILE="$SCRIPT_DIR/docker-compose.podman-compat.opensandbox.yml"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/bounded-wait.sh"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/platform-images.sh"


if [ "$MODE" = "worker-join" ]; then
  SOURCE="pull"
  if [ "${3:-}" = "pull" ] || [ "${3:-}" = "build" ]; then
    SOURCE="$3"
    shift 3
  else
    shift 2
  fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --control-plane)
        CONTROL_PLANE="${2:-}"
        shift 2
        ;;
      --control-plane=*)
        CONTROL_PLANE="${1#*=}"
        shift
        ;;
      pull|build)
        SOURCE="$1"
        shift
        ;;
      *)
        echo "未知参数: $1" >&2
        exit 2
        ;;
    esac
  done
fi

# 默认阿里云 ACR；可用 deploy/.env 覆盖
DEFAULT_IMAGE_REGISTRY="crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec"
DEFAULT_SHARED_ASSETS_HELPER_IMAGE="docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23"
DEFAULT_SILO_IMAGE="docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z"

case "$ACTION" in up|down|status|logs|check|pull) ;; *)
  echo "用法: $0 [up|down|status|logs|check|pull] [real|fake|worker-join] [pull|build]" >&2
  echo "  默认: up real pull  — 从阿里云 ACR 拉取 deepsonar-* 镜像后以真实沙箱启动" >&2
  echo "  仅状态机: $0 up fake pull" >&2
  echo "  本地构建: $0 up real build" >&2
  echo "  执行面扩容: $0 up worker-join --control-plane https://scheduler.example:3100" >&2
  exit 2
  ;;
esac
case "$MODE" in fake|real|worker-join) ;; *) echo "模式只能是 fake、real 或 worker-join" >&2; exit 2 ;; esac
if [ "$MODE" = "worker-join" ] && [ -z "$CONTROL_PLANE" ]; then
  echo "worker-join 需要 --control-plane URL 或 DEEPSONAR_CONTROL_PLANE" >&2
  exit 2
fi
case "$SOURCE" in pull|build) ;; *) echo "镜像来源只能是 pull（阿里云）或 build（本地 Dockerfile）" >&2; exit 2 ;; esac

command -v docker >/dev/null 2>&1 || { echo "缺少 docker" >&2; exit 1; }
docker compose version >/dev/null

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

ensure_env_kv() {
  # ensure_env_kv KEY VALUE — 仅在 .env 中缺失时追加
  key="$1"
  value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "[deploy] 已写入 $key=$value"
  fi
}

set_env_kv() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    tmp=$(mktemp)
    sed "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

ensure_env_secret() {
  key="$1"
  value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    current=$(sed -n "s/^${key}=//p" "$ENV_FILE" | head -1)
    case "$current" in
      ""|change-me-*)
        tmp=$(mktemp)
        sed "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
        echo "[deploy] 已生成 $key"
        ;;
    esac
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "[deploy] 已生成 $key"
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  db_secret=$(random_hex 16)
  admin_secret="deepsonar_bootstrap_$(random_hex 32)"
  sed "s/change-me-postgres-password/$db_secret/; s/change-me-bootstrap-admin-token/$admin_secret/" "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "[deploy] 已生成 deploy/.env（包含随机数据库密码和管理员引导 Token）"
fi

# Silo credentials are generated for both new and existing deployments. Values are never printed.
ensure_env_secret "BLOB_S3_ACCESS_KEY_ID" "$(random_hex 12)"
ensure_env_secret "BLOB_S3_SECRET_ACCESS_KEY" "$(random_hex 32)"
if [ "$MODE" != "worker-join" ]; then
  ensure_env_secret "DEEPSONAR_WORKER_BOOTSTRAP_TOKEN" "$(random_hex 24)"
fi

if grep -q 'change-me-' "$ENV_FILE"; then
  echo "deploy/.env 仍包含 change-me 占位符，请先设置安全值" >&2
  exit 1
fi

if ! grep -q '^DEEPSONAR_MASTER_KEY_FILE=' "$ENV_FILE"; then
  printf '\nDEEPSONAR_MASTER_KEY_FILE=/run/secrets/deepsonar_master_key\n' >> "$ENV_FILE"
fi

# 平台镜像按不可变 digest 引用（#740）：旧 DEEPSONAR_IMAGE_TAG / 可变 tag / 缺 DEEPSONAR_VERSION 一律 fail closed，
# 不自动补写、不回退 tag。worker-join 不运行平台镜像，只拒绝旧变量。
require_platform_images=1
if [ "$MODE" = "worker-join" ] && [ "$ACTION" != "pull" ]; then
  require_platform_images=0
fi
if ! ds_check_platform_image_contract "$ENV_FILE" "$ENV_EXAMPLE" "$require_platform_images"; then
  exit 1
fi

# 官方 helper / Silo 仍按 Release 版本标签解析后固定为 RepoDigest
ensure_env_kv "DEEPSONAR_IMAGE_REGISTRY" "$DEFAULT_IMAGE_REGISTRY"
ensure_env_kv "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" "$DEFAULT_SHARED_ASSETS_HELPER_IMAGE"
ensure_env_kv "SILO_IMAGE" "$DEFAULT_SILO_IMAGE"
# 允许运行时从 ACR 拉官方 Agent 镜像（只检查 ALLOWED 行，避免被 IMAGE_REGISTRY 误匹配）
ACR_HOST="crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com"
if grep -q '^DEEPSONAR_ALLOWED_IMAGE_REGISTRIES=' "$ENV_FILE"; then
  allowed_line=$(grep '^DEEPSONAR_ALLOWED_IMAGE_REGISTRIES=' "$ENV_FILE" | head -1)
  case "$allowed_line" in
    *"$ACR_HOST"*) ;;
    *)
      tmp=$(mktemp)
      sed "s|^DEEPSONAR_ALLOWED_IMAGE_REGISTRIES=\\(.*\\)|DEEPSONAR_ALLOWED_IMAGE_REGISTRIES=\\1,${ACR_HOST}|" \
        "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
      echo "[deploy] 已将阿里云 ACR 加入 DEEPSONAR_ALLOWED_IMAGE_REGISTRIES"
      ;;
  esac
else
  ensure_env_kv "DEEPSONAR_ALLOWED_IMAGE_REGISTRIES" \
    "ghcr.io,docker.io,registry-1.docker.io,${ACR_HOST}"
fi

if [ ! -f "$MASTER_KEY_FILE" ]; then
  random_hex 32 > "$MASTER_KEY_FILE"
  chmod 600 "$MASTER_KEY_FILE"
  echo "[deploy] 已生成 deploy/master.key，用于 Provider Credential 加密"
fi

# shellcheck disable=SC1090
IMAGE_REGISTRY=$(awk -F= '$1=="DEEPSONAR_IMAGE_REGISTRY" {print $2; exit}' "$ENV_FILE")
PLATFORM_VERSION=$(ds_effective_env_value "$ENV_FILE" DEEPSONAR_VERSION)
SCHEDULER_IMAGE=$(ds_effective_env_value "$ENV_FILE" DEEPSONAR_SCHEDULER_IMAGE)
WEB_IMAGE=$(ds_effective_env_value "$ENV_FILE" DEEPSONAR_WEB_IMAGE)
IMAGE_ADMISSION_IMAGE=$(ds_effective_env_value "$ENV_FILE" DEEPSONAR_IMAGE_ADMISSION_IMAGE)
SHARED_ASSETS_HELPER_IMAGE=$(awk -F= '$1=="DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" {print $2; exit}' "$ENV_FILE")
SILO_IMAGE=$(awk -F= '$1=="SILO_IMAGE" {print $2; exit}' "$ENV_FILE")
IMAGE_REGISTRY=${IMAGE_REGISTRY:-$DEFAULT_IMAGE_REGISTRY}
SILO_IMAGE=${SILO_IMAGE:-$DEFAULT_SILO_IMAGE}

if [ "$MODE" = "worker-join" ]; then
  set_env_kv "DEEPSONAR_CONTROL_PLANE" "$CONTROL_PLANE"
  export DEEPSONAR_CONTROL_PLANE="$CONTROL_PLANE"
  if ! grep -q '^DEEPSONAR_WORKER_BOOTSTRAP_TOKEN=.\+' "$ENV_FILE" 2>/dev/null; then
    echo "worker-join 需要与控制面相同的 DEEPSONAR_WORKER_BOOTSTRAP_TOKEN（写在 deploy/.env）" >&2
    exit 2
  fi
  set -- docker compose -p deepsonar-worker --env-file "$ENV_FILE" -f "$WORKER_COMPOSE_FILE"
else
  set -- docker compose -p deepsonar --env-file "$ENV_FILE" -f "$COMPOSE_FILE"
  if [ "$MODE" = "real" ]; then
    set -- "$@" -f "$REAL_COMPOSE_FILE"
  fi
  # real 默认 OpenSandbox；显式 SANDBOX_PROVIDER= 其它值才跳过 overlay。
  opensandbox_overlay=0
  if [ "$MODE" = "real" ] && [ "${SANDBOX_PROVIDER:-opensandbox}" = "opensandbox" ]; then
    set -- "$@" -f "$OPENSANDBOX_COMPOSE_FILE"
    opensandbox_overlay=1
  fi
  # Podman / stuck-healthcheck: optional service_started overlay (#726). Final probes still gate success.
  # Process env wins; otherwise adopt deploy/.env (overrides bounded-wait.sh defaults).
  if [ -z "${DEEPSONAR_COMPOSE_DEPENDS_ON_SET:-}" ]; then
    _depends=$(awk -F= '$1=="DEEPSONAR_COMPOSE_DEPENDS_ON" {print $2; exit}' "$ENV_FILE" 2>/dev/null || true)
    if [ -n "$_depends" ]; then
      DEEPSONAR_COMPOSE_DEPENDS_ON="$_depends"
      export DEEPSONAR_COMPOSE_DEPENDS_ON
    fi
  fi
  _up_to=$(awk -F= '$1=="DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC" {print $2; exit}' "$ENV_FILE" 2>/dev/null || true)
  if [ -n "${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC_SET:-}" ]; then
    :
  elif [ -n "$_up_to" ]; then
    DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC="$_up_to"
    export DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC
  fi
  _ready_to=$(awk -F= '$1=="DEEPSONAR_READY_TIMEOUT_SEC" {print $2; exit}' "$ENV_FILE" 2>/dev/null || true)
  if [ -n "${DEEPSONAR_READY_TIMEOUT_SEC_SET:-}" ]; then
    :
  elif [ -n "$_ready_to" ]; then
    DEEPSONAR_READY_TIMEOUT_SEC="$_ready_to"
    export DEEPSONAR_READY_TIMEOUT_SEC
  fi
  if ds_should_use_started_depends; then
    echo "[deploy] using service_started depends_on overlay (runtime=$(ds_detect_container_runtime); DEEPSONAR_COMPOSE_DEPENDS_ON=${DEEPSONAR_COMPOSE_DEPENDS_ON:-auto})"
    set -- "$@" -f "$PODMAN_COMPAT_FILE"
    if [ "$opensandbox_overlay" = "1" ]; then
      set -- "$@" -f "$PODMAN_COMPAT_OS_FILE"
    fi
  fi
fi

# Docker bridge + iptables-legacy FORWARD=DROP blackholes OpenSandbox/gateway.
# Only `up` may touch host FORWARD; down/logs/status/check/pull must not.
attach_opensandbox_default_bridge() {
  { [ "$MODE" = "real" ] || [ "$MODE" = "worker-join" ]; } || return 0
  [ "${SANDBOX_PROVIDER:-opensandbox}" = "opensandbox" ] || return 0
  if [ "$MODE" = "worker-join" ]; then
    name="${OPEN_SANDBOX_CONTAINER_NAME:-deepsonar-worker-opensandbox}"
  else
    name="${OPEN_SANDBOX_CONTAINER_NAME:-deepsonar-opensandbox}"
  fi
  echo "[deploy] attaching $name to Docker default bridge for egress sidecars"
  if docker network connect bridge "$name"; then
    return 0
  fi
  docker network inspect bridge --format '{{range .Containers}}{{.Name}} {{end}}' | grep -Fqw "$name"
}

relax_bridge_forward() {
  { [ "$MODE" = "real" ] || [ "$MODE" = "worker-join" ]; } || return 0
  [ "${SANDBOX_PROVIDER:-opensandbox}" = "opensandbox" ] || return 0
  command -v sudo >/dev/null 2>&1 || return 0
  echo "[deploy] relaxing Docker FORWARD policy for OpenSandbox bridge (up only)"
  if sudo -n iptables-legacy -P FORWARD ACCEPT 2>/dev/null \
    || sudo -n iptables -P FORWARD ACCEPT 2>/dev/null; then
    return 0
  fi
  echo "[deploy] could not set FORWARD ACCEPT; docker0/bridge rules may still drop packets" >&2
}

cd "$REPO_ROOT"

pull_app_images() {
  echo "[deploy] 按不可变 digest 拉取平台镜像（DEEPSONAR_VERSION=${PLATFORM_VERSION}）"
  for ref in "$SCHEDULER_IMAGE" "$WEB_IMAGE" "$IMAGE_ADMISSION_IMAGE"; do
    echo "[deploy] pull $ref"
    docker pull "$ref"
  done
}

print_platform_images() {
  echo "[deploy] 平台版本: DEEPSONAR_VERSION=${PLATFORM_VERSION}"
  echo "[deploy] scheduler: ${SCHEDULER_IMAGE}"
  echo "[deploy] web: ${WEB_IMAGE}"
  echo "[deploy] image-admission: ${IMAGE_ADMISSION_IMAGE}"
}

HELPER_IMAGE_DIGEST_RE='^[^@[:space:]]+@sha256:[0-9a-f]{64}$'

validate_shared_assets_helper_image() {
  if ! printf '%s\n' "$SHARED_ASSETS_HELPER_IMAGE" | grep -Eq "$HELPER_IMAGE_DIGEST_RE"; then
    echo "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE 必须是带 64 位 sha256 digest 的 immutable image 引用" >&2
    exit 1
  fi
}

resolve_repo_digest() {
  tag="$1"
  needle="$2"
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag" 2>/dev/null \
    | grep -E "$HELPER_IMAGE_DIGEST_RE" \
    | grep -F "$needle" \
    | head -1 \
    || true
}

pull_shared_assets_helper() {
  [ "$MODE" = "real" ] || return 0
  official_tag="${IMAGE_REGISTRY}/deepsonar-assets-helper:${PLATFORM_VERSION}"
  echo "[deploy] 尝试拉取官方共享资产 helper：$official_tag"
  if docker pull "$official_tag"; then
    official_digest=$(resolve_repo_digest "$official_tag" "deepsonar-assets-helper@")
    if printf '%s\n' "$official_digest" | grep -Eq "$HELPER_IMAGE_DIGEST_RE"; then
      SHARED_ASSETS_HELPER_IMAGE="$official_digest"
      set_env_kv "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" "$SHARED_ASSETS_HELPER_IMAGE"
      export DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE="$SHARED_ASSETS_HELPER_IMAGE"
      echo "[deploy] 已解析官方 helper 不可变引用：$SHARED_ASSETS_HELPER_IMAGE"
      return 0
    fi
    echo "[deploy] 官方 helper 缺少 RepoDigest，回退 busybox pin"
  else
    echo "[deploy] 官方 helper 标签不可用（当前 Release 可能尚未发布），回退 busybox pin"
  fi
  SHARED_ASSETS_HELPER_IMAGE=${SHARED_ASSETS_HELPER_IMAGE:-$DEFAULT_SHARED_ASSETS_HELPER_IMAGE}
  validate_shared_assets_helper_image
  echo "[deploy] 拉取共享资产 helper：$SHARED_ASSETS_HELPER_IMAGE"
  docker pull "$SHARED_ASSETS_HELPER_IMAGE"
}

prefer_official_silo() {
  case "$SILO_IMAGE" in
    ""|"$DEFAULT_SILO_IMAGE"|*deepsonar-silo*) return 0 ;;
    *) return 1 ;;
  esac
}

pull_official_silo() {
  if ! prefer_official_silo; then
    echo "[deploy] 使用已覆盖的 SILO_IMAGE=$SILO_IMAGE"
    docker pull "$SILO_IMAGE"
    return 0
  fi
  official_tag="${IMAGE_REGISTRY}/deepsonar-silo:${PLATFORM_VERSION}"
  echo "[deploy] 尝试拉取官方 Silo：$official_tag"
  if docker pull "$official_tag"; then
    official_digest=$(resolve_repo_digest "$official_tag" "deepsonar-silo@")
    if printf '%s\n' "$official_digest" | grep -Eq "$HELPER_IMAGE_DIGEST_RE"; then
      SILO_IMAGE="$official_digest"
    else
      SILO_IMAGE="$official_tag"
    fi
    set_env_kv "SILO_IMAGE" "$SILO_IMAGE"
    export SILO_IMAGE
    echo "[deploy] 已设置 SILO_IMAGE=$SILO_IMAGE"
    return 0
  fi
  echo "[deploy] 官方 Silo 标签不可用（当前 Release 可能尚未发布），回退 $DEFAULT_SILO_IMAGE"
  SILO_IMAGE=${SILO_IMAGE:-$DEFAULT_SILO_IMAGE}
  echo "[deploy] 拉取 Silo：$SILO_IMAGE"
  docker pull "$SILO_IMAGE"
}

case "$ACTION" in
  check)
    "$@" config --quiet
    if [ "$MODE" = "real" ]; then
      validate_shared_assets_helper_image
    fi
    echo "[deploy] Compose 配置有效"
    if [ "$require_platform_images" = "1" ]; then
      print_platform_images
    fi
    ;;
  status)
    "$@" ps
    ;;
  logs)
    "$@" logs -f --tail 200
    ;;
  pull)
    pull_app_images
    pull_official_silo
    pull_shared_assets_helper
    echo "[deploy] 应用镜像已拉取"
    ;;
  down)
    "$@" down
    echo "[deploy] 服务已停止，数据库和 blob volume 已保留"
    ;;
  up)
    relax_bridge_forward
    "$@" config --quiet
    if [ "$MODE" = "worker-join" ]; then
      if [ "$SOURCE" = "build" ]; then
        if ds_run_bounded "${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC:-600}" "$@" up -d --build; then
          :
        else
          rc=$?
          ds_dump_deploy_diagnostics "$@"
          echo "[deploy] worker-join compose up failed or timed out (exit=$rc)" >&2
          exit "$rc"
        fi
      else
        if ds_run_bounded "${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC:-600}" "$@" up -d --pull missing; then
          :
        else
          rc=$?
          ds_dump_deploy_diagnostics "$@"
          echo "[deploy] worker-join compose up failed or timed out (exit=$rc)" >&2
          exit "$rc"
        fi
      fi
      attach_opensandbox_default_bridge
      echo "[deploy] worker-join 已启动（compose project=deepsonar-worker）"
      echo "[deploy] control-plane=$CONTROL_PLANE endpoint=${DEEPSONAR_WORKER_ENDPOINT:-unset}"
      echo "[deploy] 单机控制面仍用 ./deploy/deploy.sh up real；同宿主即一个 local worker"
      break_worker=1
    fi
    if [ "${break_worker:-}" != "1" ]; then
    pull_official_silo
    pull_shared_assets_helper
    up_rc=0
    if [ "$SOURCE" = "build" ]; then
      echo "[deploy] 本地 Dockerfile 构建模式（平台镜像临时标记为 *:${DS_LOCAL_BUILD_TAG}，不改写 deploy/.env 的 digest 引用）"
      ds_export_local_build_platform_images
      if ds_run_bounded "${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC:-600}" "$@" up -d --build; then
        up_rc=0
      else
        up_rc=$?
      fi
    else
      pull_app_images
      # 不传 --build：优先使用已拉取的 image: 标签，避免强制本地构建
      if ds_run_bounded "${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC:-600}" "$@" up -d --pull missing; then
        up_rc=0
      else
        up_rc=$?
      fi
    fi
    if [ "$up_rc" -ne 0 ]; then
      echo "[deploy] compose up exited $up_rc (124=timeout); checking whether infra is actually ready (#726)" >&2
      ds_dump_deploy_diagnostics "$@"
      if [ "$up_rc" -eq 124 ] && ds_infra_really_ready "$@"; then
        echo "[deploy] infra real probes passed despite compose health wait timeout; taking controlled path"
        if ! ds_ensure_app_services_started "$@"; then
          ds_dump_deploy_diagnostics "$@"
          echo "[deploy] controlled path failed to start app services; blocker is compose health / dependency chain" >&2
          exit 1
        fi
      else
        echo "[deploy] compose up failed within ${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC:-600}s; dependency not ready or healthcheck stuck" >&2
        exit "$up_rc"
      fi
    fi
    attach_opensandbox_default_bridge
    # Real readiness (Running ≠ ready): postgres + silo, then entry port.
    if ! ds_wait_infra_ready "$@"; then
      ds_dump_deploy_diagnostics "$@"
      echo "[deploy] postgres/silo real probes failed; refusing success via service_started alone" >&2
      exit 1
    fi
    port=$(awk -F= '$1=="DEEPSONAR_WEB_PORT" {print $2; exit}' "$ENV_FILE")
    port=${port:-8080}
    if ! ds_wait_entry_ready "$port" "${DEEPSONAR_READY_TIMEOUT_SEC:-180}" "$@"; then
      ds_dump_deploy_diagnostics "$@"
      # Name likely blockers for operators.
      ds_compose_blocker_hint "$@"
      echo "[deploy] entry readiness failed: web/scheduler not reachable on :$port within ${DEEPSONAR_READY_TIMEOUT_SEC:-180}s" >&2
      exit 1
    fi
    # Confirm web + scheduler containers are up (not merely Created).
    for svc in scheduler web; do
      state=$(ds_service_state "$svc" "$@" || echo missing)
      case "$state" in
        running\ *) ;;
        *)
          ds_dump_deploy_diagnostics "$@"
          echo "[deploy] required service $svc is not running (state=$state)" >&2
          exit 1
          ;;
      esac
    done
    echo "[deploy] DeepSonar 已启动：http://127.0.0.1:$port"
    if [ "$SOURCE" = "build" ]; then
      echo "[deploy] 平台镜像：本地构建 *:${DS_LOCAL_BUILD_TAG}（DEEPSONAR_VERSION=${PLATFORM_VERSION}）"
    else
      print_platform_images
    fi
    echo "[deploy] 管理员引导 Token 保存在 deploy/.env 的 DEEPSONAR_ADMIN_TOKEN，请勿提交该文件。"
    echo "[deploy] 人类默认管理员：admin / Deep@Sonar66；生产首次登录后必须立即修改密码并建议修改登录名。"
    if [ "$MODE" = "fake" ]; then
      echo "[deploy] 当前为 fake 模式（仅状态机）；真实沙箱请使用：./deploy/deploy.sh up real"
    else
      echo "[deploy] 当前为 real 模式（真实沙箱）；需挂载容器 runtime socket（见 docker-compose.real.yml）"
      if [ "${SANDBOX_PROVIDER:-opensandbox}" = "opensandbox" ]; then
        echo "[deploy] SANDBOX_PROVIDER=opensandbox overlay enabled (docker-compose.opensandbox.prod.yml)"
      fi
    fi
    echo "[deploy] Scheduler is ready; /api/health reports ready=true (runtime images and Dispatcher ready)"
    fi
    ;;
esac
