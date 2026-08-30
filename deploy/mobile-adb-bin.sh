#!/usr/bin/env bash
set -euo pipefail
adb_home="${ADB_HOME:-/opt/deepsonar/platform-tools}"
adb_bin="${adb_home}/adb"
if [[ ! -x "$adb_bin" ]]; then
  printf 'adb 未安装：缺少 %s\n' "$adb_bin" >&2
  exit 127
fi
machine="$(uname -m)"
if [[ "$machine" == "aarch64" || "$machine" == "arm64" ]]; then
  exec qemu-x86_64-static "$adb_bin" "$@"
fi
exec "$adb_bin" "$@"
