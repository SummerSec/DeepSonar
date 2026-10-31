#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：mobile-hap.sh --check | inspect <file.hap>

OpenHarmony HAP 静态检查：列出 ZIP 并打印 pack.info / module.json / module.json5（若存在）。
这不是设备证据；动态结果必须来自 hdc。
EOF
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  command -v unzip >/dev/null 2>&1 || {
    printf 'HAP 检查失败：缺少 unzip\n' >&2
    exit 1
  }
  printf 'OpenHarmony HAP helper 已就绪（unzip + pack.info/module.json）\n'
  exit 0
fi

if [[ "${1:-}" == "inspect" && $# -eq 2 ]]; then
  hap="$2"
  [[ -f "$hap" ]] || {
    printf 'HAP 检查失败：文件不存在 %s\n' "$hap" >&2
    exit 1
  }
  unzip -l "$hap"
  for name in pack.info module.json module.json5 config.json; do
    if unzip -l "$hap" | grep -qE "(^|[[:space:]])${name}$|/${name}$"; then
      printf '\n----- %s -----\n' "$name"
      unzip -p "$hap" "$name" 2>/dev/null || unzip -p "$hap" "*/$name" 2>/dev/null || true
    fi
  done
  exit 0
fi

usage >&2
exit 2
