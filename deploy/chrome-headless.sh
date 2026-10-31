#!/usr/bin/env bash
# Scheduler-governed browser launcher. Agents receive this wrapper instead of
# a free-form Chromium command, so the required isolation flags cannot be
# omitted or replaced by an arbitrary executable.
set -euo pipefail

port="${CHROME_REMOTE_DEBUGGING_PORT:-9222}"
user_data_dir="${CHROME_USER_DATA_DIR:-/workspace/.deepsonar-chrome-profile}"
url="about:blank"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) [[ $# -ge 2 ]] || { echo '缺少 --port 参数值' >&2; exit 2; }; port="$2"; shift 2 ;;
    --user-data-dir) [[ $# -ge 2 ]] || { echo '缺少 --user-data-dir 参数值' >&2; exit 2; }; user_data_dir="$2"; shift 2 ;;
    --url) [[ $# -ge 2 ]] || { echo '缺少 --url 参数值' >&2; exit 2; }; url="$2"; shift 2 ;;
    -h|--help) echo '用法：chrome-headless.sh [--port N] [--user-data-dir PATH] [--url URL]'; exit 0 ;;
    *) printf '不允许的 Chrome 参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$port" =~ ^[1-9][0-9]{2,4}$ ]] || { echo 'port 必须是有效端口' >&2; exit 2; }
[[ "$user_data_dir" == /workspace/* ]] || { echo 'user-data-dir 必须位于 /workspace 下' >&2; exit 2; }
mkdir -p "$user_data_dir"
exec "${CHROME_BIN:-/usr/bin/chromium}" \
  --no-sandbox \
  --headless=new \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-component-update \
  --disable-default-apps \
  --no-first-run \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$port" \
  --user-data-dir="$user_data_dir" \
  "$url"
