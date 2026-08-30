#!/usr/bin/env bash
set -euo pipefail

idevice_bin="${IDEVICE_ID_BIN:-idevice_id}"

usage() {
  cat <<'EOF'
用法：mobile-ios.sh --check | devices

Linux 宿主 iOS 协议（libimobiledevice）。无 Xcode / Simulator。
IPA 静态检查用 unzip + plistutil。无 USB 设备时不得把 IPA 解压叙述写成设备结果。
EOF
}

require_idevice() {
  if ! command -v "$idevice_bin" >/dev/null 2>&1; then
    printf 'iOS 检查失败：缺少命令 %s\n' "$idevice_bin" >&2
    exit 1
  fi
}

emit_no_target() {
  cat <<'EOF'
{"protocol":"usbmuxd","status":"needs_human","verdict":"inconclusive","reason":"no_ios_target","message":"No iOS device is reachable from this Linux sandbox. USB/usbmuxd mapping is out of scope. Do not invent device results from IPA unzip.","targets":[]}
EOF
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  require_idevice
  for command_name in ideviceinstaller plistutil iproxy; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'iOS 检查失败：缺少命令 %s\n' "$command_name" >&2
      exit 1
    }
  done
  devices="$("$idevice_bin" -l 2>&1 || true)"
  printf '%s\n' "$devices"
  cleaned="$(printf '%s' "$devices" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -z "$cleaned" ]]; then
    printf 'no_ios_target needs_human inconclusive\n'
  fi
  exit 0
fi

if [[ "${1:-}" == "devices" && $# -eq 1 ]]; then
  require_idevice
  raw="$("$idevice_bin" -l 2>&1 || true)"
  cleaned="$(printf '%s' "$raw" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -z "$cleaned" ]]; then
    emit_no_target
    exit 2
  fi
  printf '%s\n' "$cleaned" | jq -R -s '{protocol:"usbmuxd",status:"ok",targets:[split("\n")[] | gsub("^\\s+|\\s+$";"") | select(length>0)]}'
  exit 0
fi

usage >&2
exit 2
