#!/usr/bin/env bash
set -euo pipefail

adb_bin="${ADB_BIN:-/opt/deepsonar/bin/adb}"

usage() {
  cat <<'EOF'
用法：mobile-adb.sh --check

检查钉死的官方 ADB 是否能打印版本。无设备时不得把主机反编译叙述写成设备结果。
EOF
}

run_adb() {
  "$adb_bin" "$@"
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  version="$(run_adb version 2>&1 || true)"
  if [[ "$version" != *"Android Debug Bridge"* && "$version" != *"Version"* ]]; then
    printf 'adb version smoke failed\n%s\n' "$version" >&2
    exit 1
  fi
  printf '%s\n' "$version"
  devices="$(run_adb devices 2>&1 || true)"
  if [[ "$devices" != *$'\n'*device* && "$devices" != *$'\t'device* ]]; then
    printf 'no_adb_target needs_human inconclusive\n'
  fi
  exit 0
fi

usage >&2
exit 2
