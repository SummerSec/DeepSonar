#!/usr/bin/env bash
# =============================================================================
# DeepSonar 裸金属生产守护脚本（本机 docker=rootless podman 不可用时的替代方案）
# 用 nohup + setsid 让 scheduler/web 脱离会话常驻，进程被 init 收养，会话结束不退。
#
# 用法：
#   ./deploy/local-daemon.sh start    # 启动 scheduler + web（已运行则跳过）
#   ./deploy/local-daemon.sh stop     # 停止
#   ./deploy/local-daemon.sh restart  # 重启
#   ./deploy/local-daemon.sh status   # 查看状态
#
# 前置：PG 已起（pg_ctl -D /home/sum/pgdata start）；已 pnpm build（scheduler/web dist 存在）。
# 日志：data/logs/{scheduler,web}.log   PID：data/run/{scheduler,web}.pid
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/data/run"
LOG="$ROOT/data/logs"
WEB_PORT="${DEEPSONAR_WEB_PORT:-8080}"
mkdir -p "$RUN" "$LOG"

pid_scheduler() { pgrep -f "node $ROOT/apps/scheduler/dist/index.js" | head -1 || true; }
pid_web()       { pgrep -f "node $ROOT/deploy/web-server.mjs" | head -1 || true; }

start_one() {
  local name="$1" cmd="$2"
  if [ -n "$(pid_scheduler 2>/dev/null)" ] && [ "$name" = scheduler ]; then
    echo "scheduler 已在运行 pid=$(pid_scheduler)"; return
  fi
  if [ -n "$(pid_web 2>/dev/null)" ] && [ "$name" = web ]; then
    echo "web 已在运行 pid=$(pid_web)"; return
  fi
  eval "$cmd"
  disown || true
}

start_scheduler() {
  nohup setsid node "$ROOT/apps/scheduler/dist/index.js" > "$LOG/scheduler.log" 2>&1 < /dev/null &
}
start_web() {
  nohup setsid env PUBLIC_ROOT="$ROOT/apps/web/dist" HOST=0.0.0.0 PORT="$WEB_PORT" \
    SCHEDULER_URL=http://127.0.0.1:3100 node "$ROOT/deploy/web-server.mjs" > "$LOG/web.log" 2>&1 < /dev/null &
}

case "${1:-status}" in
  start)
    [ -z "$(pid_scheduler)" ] && { start_scheduler; echo "scheduler 已启动"; } || echo "scheduler 已在运行 pid=$(pid_scheduler)"
    [ -z "$(pid_web)" ] && { start_web; echo "web 已启动"; } || echo "web 已在运行 pid=$(pid_web)"
    sleep 5
    exec "$0" status
    ;;
  stop)
    for kind in scheduler web; do
      pid=$(pid_scheduler); [ "$kind" = web ] && pid=$(pid_web)
      if [ -n "$pid" ]; then kill "$pid" 2>/dev/null && echo "已停止 $kind pid=$pid"; fi
    done
    sleep 1
    exec "$0" status
    ;;
  restart) "$0" stop; sleep 2; exec "$0" start ;;
  status)
    sp=$(pid_scheduler); wp=$(pid_web)
    echo "scheduler: ${sp:-未运行}  ${sp:+(ppid $(ps -o ppid= -p "$sp" 2>/dev/null))}"
    echo "web:       ${wp:-未运行}  ${wp:+(ppid $(ps -o ppid= -p "$wp" 2>/dev/null))}"
    ss -tlnp 2>/dev/null | grep -E ":(3100|${WEB_PORT})\b" || echo "（3100/$WEB_PORT 未监听）"
    ;;
  *) echo "用法: $0 {start|stop|status|restart}"; exit 1 ;;
esac