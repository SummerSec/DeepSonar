#!/usr/bin/env bash
set -euo pipefail

command -v clickhouse >/dev/null 2>&1 || { echo 'actual official clickhouse is unavailable; refusing toy fallback' >&2; exit 1; }
command -v clickhouse-local >/dev/null 2>&1 || { echo 'clickhouse-local is unavailable; refusing toy fallback' >&2; exit 1; }
version="$(clickhouse --version)"
[[ "$version" == *26.3.28.5* ]] || { echo "clickhouse is not the pinned official 26.3.28.5 binary: ${version}" >&2; exit 1; }
result="$(clickhouse local -q 'SELECT 40 + 2')"
[[ "$result" == "42" ]] || { echo "clickhouse-local smoke returned ${result}, expected 42" >&2; exit 1; }
corpus="$(mktemp -d /tmp/deepsonar-clickhouse-fuzzer.XXXXXX)"
trap 'rm -rf -- "$corpus"' EXIT
printf 'SELECT 1\nSELECT * FROM system.one\n' >"$corpus/seed.sql"
clickhouse local --queries-file "$corpus/seed.sql" >/dev/null
printf 'ClickHouse Fuzz official clickhouse-local smoke passed: %s\n' "$version"
