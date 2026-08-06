#!/usr/bin/env sh
set -eu

ACTION="${1:-up}"
MODE="${2:-real}"
SOURCE="${3:-pull}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
MASTER_KEY_FILE="$SCRIPT_DIR/master.key"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.prod.yml"
REAL_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.real.yml"

# 默认阿里云 ACR；可用 deploy/.env 覆盖
DEFAULT_IMAGE_REGISTRY="crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec"
DEFAULT_IMAGE_TAG="latest"

case "$ACTION" in up|down|status|logs|check|pull) ;; *)
  echo "用法: $0 [up|down|status|logs|check|pull] [real|fake] [pull|build]" >&2
  echo "  默认: up real pull  — 从阿里云 ACR 拉取 deepsonar-* 镜像后以真实沙箱启动" >&2
  echo "  仅状态机: $0 up fake pull" >&2
  echo "  本地构建: $0 up real build" >&2
  exit 2
  ;;
esac
case "$MODE" in fake|real) ;; *) echo "模式只能是 fake 或 real" >&2; exit 2 ;; esac
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

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  db_secret=$(random_hex 16)
  admin_secret="deepsonar_bootstrap_$(random_hex 32)"
  sed "s/change-me-postgres-password/$db_secret/; s/change-me-bootstrap-admin-token/$admin_secret/" "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "[deploy] 已生成 deploy/.env（包含随机数据库密码和管理员引导 Token）"
fi

if grep -q 'change-me-' "$ENV_FILE"; then
  echo "deploy/.env 仍包含 change-me 占位符，请先设置安全值" >&2
  exit 1
fi

if ! grep -q '^DEEPSONAR_MASTER_KEY_FILE=' "$ENV_FILE"; then
  printf '\nDEEPSONAR_MASTER_KEY_FILE=/run/secrets/deepsonar_master_key\n' >> "$ENV_FILE"
fi

# 默认镜像源：阿里云 ACR + 当前发布标签
ensure_env_kv "DEEPSONAR_IMAGE_REGISTRY" "$DEFAULT_IMAGE_REGISTRY"
ensure_env_kv "DEEPSONAR_IMAGE_TAG" "$DEFAULT_IMAGE_TAG"
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
IMAGE_TAG=$(awk -F= '$1=="DEEPSONAR_IMAGE_TAG" {print $2; exit}' "$ENV_FILE")
IMAGE_REGISTRY=${IMAGE_REGISTRY:-$DEFAULT_IMAGE_REGISTRY}
IMAGE_TAG=${IMAGE_TAG:-$DEFAULT_IMAGE_TAG}

set -- docker compose -p deepsonar --env-file "$ENV_FILE" -f "$COMPOSE_FILE"
if [ "$MODE" = "real" ]; then
  set -- "$@" -f "$REAL_COMPOSE_FILE"
fi

cd "$REPO_ROOT"

pull_app_images() {
  echo "[deploy] 从阿里云拉取应用镜像：${IMAGE_REGISTRY} tag=${IMAGE_TAG}"
  for name in deepsonar-scheduler deepsonar-web deepsonar-image-admission; do
    ref="${IMAGE_REGISTRY}/${name}:${IMAGE_TAG}"
    echo "[deploy] pull $ref"
    docker pull "$ref"
  done
}

case "$ACTION" in
  check)
    "$@" config --quiet
    echo "[deploy] Compose 配置有效"
    echo "[deploy] 镜像源: ${IMAGE_REGISTRY} / ${IMAGE_TAG}（默认阿里云 ACR）"
    ;;
  status)
    "$@" ps
    ;;
  logs)
    "$@" logs -f --tail 200
    ;;
  pull)
    pull_app_images
    echo "[deploy] 应用镜像已拉取"
    ;;
  down)
    "$@" down
    echo "[deploy] 服务已停止，数据库和 blob volume 已保留"
    ;;
  up)
    "$@" config --quiet
    if [ "$SOURCE" = "build" ]; then
      echo "[deploy] 本地 Dockerfile 构建模式"
      "$@" up -d --build
    else
      pull_app_images
      # 不传 --build：优先使用已拉取的 image: 标签，避免强制本地构建
      "$@" up -d --pull missing
    fi
    port=$(awk -F= '$1=="DEEPSONAR_WEB_PORT" {print $2; exit}' "$ENV_FILE")
    port=${port:-8080}
    health="http://127.0.0.1:$port/api/health"
    ready=0
    i=0
    while [ "$i" -lt 60 ]; do
      if command -v curl >/dev/null 2>&1 && curl -fsS "$health" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 2
      i=$((i + 1))
    done
    if [ "$ready" -ne 1 ]; then
      "$@" ps
      "$@" logs --tail 100 scheduler image-admission web
      echo "服务未在 120 秒内通过健康检查：$health" >&2
      exit 1
    fi
    echo "[deploy] DeepSonar 已启动：http://127.0.0.1:$port"
    echo "[deploy] 应用镜像：${IMAGE_REGISTRY}/*:${IMAGE_TAG}"
    echo "[deploy] 管理员引导 Token 保存在 deploy/.env 的 DEEPSONAR_ADMIN_TOKEN，请勿提交该文件。"
    echo "[deploy] 人类默认管理员：admin / Deep@Sonar66；生产首次登录后必须立即修改密码并建议修改登录名。"
    if [ "$MODE" = "fake" ]; then
      echo "[deploy] 当前为 fake 模式（仅状态机）；真实沙箱请使用：./deploy/deploy.sh up real"
    else
      echo "[deploy] 当前为 real 模式（真实沙箱）；需挂载容器 runtime socket（见 docker-compose.real.yml）"
    fi
    mkdir -p "$REPO_ROOT/data/logs"
    nohup env DEEPSONAR_URL="http://127.0.0.1:$port/api" \
      "$REPO_ROOT/deploy/prepare-runtime-images.sh" \
      >> "$REPO_ROOT/data/logs/runtime-images.log" 2>&1 < /dev/null &
    echo "[deploy] 运行时镜像准备已后台启动，日志：$REPO_ROOT/data/logs/runtime-images.log"
    ;;
esac
