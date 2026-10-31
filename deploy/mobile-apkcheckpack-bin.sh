#!/usr/bin/env bash
set -euo pipefail
apkcheckpack_home="${APKCHECKPACK_HOME:-/opt/deepsonar/apkcheckpack}"
apkcheckpack_bin="${APKCHECKPACK_BIN:-${apkcheckpack_home}/ApkCheckPack}"
if [[ ! -x "$apkcheckpack_bin" ]]; then
  printf 'apkcheckpack 未安装：缺少 %s\n' "$apkcheckpack_bin" >&2
  exit 127
fi
machine="$(uname -m)"
if [[ "$machine" == "aarch64" || "$machine" == "arm64" ]]; then
  exec qemu-x86_64-static "$apkcheckpack_bin" "$@"
fi
exec "$apkcheckpack_bin" "$@"
