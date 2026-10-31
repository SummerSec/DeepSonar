#!/usr/bin/env bash
# Scheduler-governed local ClickHouse server launcher. Agents receive this
# wrapper instead of a free-form clickhouse-server command, so listen address,
# data path, memory and thread pools cannot leave the sandbox budget.
set -euo pipefail

bin="${CLICKHOUSE_BIN:-/opt/deepsonar/bin/clickhouse}"
path="${CLICKHOUSE_PATH:-/workspace/.clickhouse}"
http_port="${CLICKHOUSE_HTTP_PORT:-8123}"
tcp_port="${CLICKHOUSE_TCP_PORT:-9000}"
config_helper="$(cd "$(dirname "$0")" && pwd)/clickhouse-sandbox-config.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) [[ $# -ge 2 ]] || { echo '缺少 --path 参数值' >&2; exit 2; }; path="$2"; shift 2 ;;
    --http-port) [[ $# -ge 2 ]] || { echo '缺少 --http-port 参数值' >&2; exit 2; }; http_port="$2"; shift 2 ;;
    --tcp-port) [[ $# -ge 2 ]] || { echo '缺少 --tcp-port 参数值' >&2; exit 2; }; tcp_port="$2"; shift 2 ;;
    -h|--help) echo '用法：clickhouse-server.sh [--path PATH] [--http-port N] [--tcp-port N]'; exit 0 ;;
    *) printf '不允许的 ClickHouse 参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$path" == /workspace/* ]] || { echo 'data path 必须位于 /workspace 下' >&2; exit 2; }
[[ "$http_port" =~ ^[1-9][0-9]{2,4}$ ]] || { echo 'http-port 必须是有效端口' >&2; exit 2; }
[[ "$tcp_port" =~ ^[1-9][0-9]{2,4}$ ]] || { echo 'tcp-port 必须是有效端口' >&2; exit 2; }
[[ -x "$config_helper" ]] || { echo '缺少 clickhouse-sandbox-config.sh' >&2; exit 2; }

"$config_helper" "$path" "$http_port" "$tcp_port"

export CLICKHOUSE_WATCHDOG_ENABLE=0
exec "$bin" server --config-file "$path/config.xml"
