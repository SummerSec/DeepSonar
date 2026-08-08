#!/usr/bin/env bash
set -euo pipefail

command -v d8 >/dev/null 2>&1 || { echo 'actual V8 d8 is unavailable; refusing toy fallback' >&2; exit 1; }
command -v v8_simple_json_fuzzer >/dev/null 2>&1 || { echo 'real V8 libFuzzer target is unavailable; refusing toy fallback' >&2; exit 1; }
version="$(d8 --version)"
[[ "$version" == V8* ]] || { echo 'd8 is not the V8 d8 binary' >&2; exit 1; }
result="$(d8 -e 'print(40 + 2)')"
[[ "$result" == "42" ]] || { echo "d8 smoke returned ${result}, expected 42" >&2; exit 1; }
corpus="$(mktemp -d /tmp/deepsonar-v8-fuzzer.XXXXXX)"
trap 'rm -rf -- "$corpus"' EXIT
printf '{"chrome":"smoke","value":42}\n' >"$corpus/seed.json"
v8_simple_json_fuzzer -runs=1 "$corpus"
printf 'Chrome Fuzz d8 + libFuzzer smoke passed: %s\n' "$version"
