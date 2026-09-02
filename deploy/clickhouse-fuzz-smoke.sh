#!/usr/bin/env bash
set -euo pipefail

command -v clickhouse >/dev/null 2>&1 || { echo 'actual official clickhouse is unavailable; refusing toy fallback' >&2; exit 1; }
command -v clickhouse-local >/dev/null 2>&1 || { echo 'clickhouse-local is unavailable; refusing toy fallback' >&2; exit 1; }
version="$(clickhouse --version)"
[[ "$version" == *26.3.28.5* ]] || { echo "clickhouse is not the pinned official 26.3.28.5 binary: ${version}" >&2; exit 1; }

config_helper="$(cd "$(dirname "$0")" && pwd)/clickhouse-sandbox-config.sh"
[[ -x "$config_helper" ]] || { echo '缺少 clickhouse-sandbox-config.sh' >&2; exit 1; }
work="$(mktemp -d /workspace/.clickhouse-fuzz-XXXXXX)"
trap 'rm -rf -- "$work"' EXIT
"$config_helper" "$work"
export CLICKHOUSE_WATCHDOG_ENABLE=0

result="$(clickhouse local --config-file "$work/config.xml" -q 'SELECT 40 + 2')"
[[ "$result" == "42" ]] || { echo "clickhouse-local smoke returned ${result}, expected 42" >&2; exit 1; }
printf 'SELECT 1\nSELECT * FROM system.one\n' >"$work/seed.sql"
clickhouse local --config-file "$work/config.xml" --queries-file "$work/seed.sql" >/dev/null
printf 'ClickHouse Fuzz official clickhouse-local smoke passed: %s\n' "$version"
