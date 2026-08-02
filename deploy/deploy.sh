#!/usr/bin/env sh
set -eu

ACTION="${1:-up}"
MODE="${2:-fake}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
MASTER_KEY_FILE="$SCRIPT_DIR/master.key"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.prod.yml"
REAL_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.real.yml"

case "$ACTION" in up|down|status|logs|check) ;; *) echo "用法: $0 [up|down|status|logs|check] [fake|real]" >&2; exit 2 ;; esac
case "$MODE" in fake|real) ;; *) echo "模式只能是 fake 或 real" >&2; exit 2 ;; esac

command -v docker >/dev/null 2>&1 || { echo "缺少 docker" >&2; exit 1; }
docker compose version >/dev/null

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  db_secret=$(random_hex 16)
  admin_secret="dfh_bootstrap_$(random_hex 32)"
  sed "s/change-me-postgres-password/$db_secret/; s/change-me-bootstrap-admin-token/$admin_secret/" "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "[deploy] 已生成 deploy/.env（包含随机数据库密码和管理员引导 Token）"
fi

if grep -q 'change-me-' "$ENV_FILE"; then
  echo "deploy/.env 仍包含 change-me 占位符，请先设置安全值" >&2
  exit 1
fi

if ! grep -q '^DFH_MASTER_KEY_FILE=' "$ENV_FILE"; then
  printf '\nDFH_MASTER_KEY_FILE=/run/secrets/dfh_master_key\n' >> "$ENV_FILE"
fi

if [ ! -f "$MASTER_KEY_FILE" ]; then
  random_hex 32 > "$MASTER_KEY_FILE"
  chmod 600 "$MASTER_KEY_FILE"
  echo "[deploy] 已生成 deploy/master.key，用于 Provider Credential 加密"
fi

set -- docker compose -p deepflowhunter --env-file "$ENV_FILE" -f "$COMPOSE_FILE"
if [ "$MODE" = "real" ]; then
  set -- "$@" -f "$REAL_COMPOSE_FILE"
fi

cd "$REPO_ROOT"

case "$ACTION" in
  check)
    "$@" config --quiet
    echo "[deploy] Compose 配置有效"
    ;;
  status)
    "$@" ps
    ;;
  logs)
    "$@" logs -f --tail 200
    ;;
  down)
    "$@" down
    echo "[deploy] 服务已停止，数据库和 blob volume 已保留"
    ;;
  up)
    "$@" config --quiet
    "$@" up -d --build
    port=$(awk -F= '$1=="DFH_WEB_PORT" {print $2; exit}' "$ENV_FILE")
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
      "$@" logs --tail 100 scheduler web
      echo "服务未在 120 秒内通过健康检查：$health" >&2
      exit 1
    fi
    echo "[deploy] DeepSonar 已启动：http://127.0.0.1:$port"
    echo "[deploy] 管理员引导 Token 保存在 deploy/.env 的 DFH_ADMIN_TOKEN，请勿提交该文件。"
    if [ "$MODE" = "fake" ]; then
      echo "[deploy] 当前为 fake 模式；真实 Agent 请使用：./deploy/deploy.sh up real"
    fi
    ;;
esac
