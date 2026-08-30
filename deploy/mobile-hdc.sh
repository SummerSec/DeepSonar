#!/usr/bin/env bash
set -euo pipefail

hdc_bin="${HDC_BIN:-hdc}"

usage() {
  cat <<'EOF'
用法：mobile-hdc.sh --check | targets | -- hdc-args...

OpenHarmony 设备协议入口（hdc）。动态证据必须来自 hdc 目标，禁止用 HAP 解压或主机叙述冒充设备结果。

  --check     冒烟 hdc version / hdc -v，不要求真机
  targets     hdc list targets；无目标时输出 needs_human / inconclusive JSON
  -- ARGS     透传官方 hdc（shell / file send|recv / install / hilog / fport / tconn）
EOF
}

require_hdc() {
  if ! command -v "$hdc_bin" >/dev/null 2>&1; then
    printf 'OpenHarmony hdc 检查失败：缺少命令 %s\n' "$hdc_bin" >&2
    exit 1
  fi
}

smoke_version() {
  require_hdc
  local version verbose
  version="$("$hdc_bin" version 2>&1 || true)"
  verbose="$("$hdc_bin" -v 2>&1 || true)"
  if [[ "${version}${verbose}" != *Ver:* ]]; then
    printf 'OpenHarmony hdc 检查失败：hdc version / hdc -v 无有效输出\n%s\n%s\n' "$version" "$verbose" >&2
    exit 1
  fi
  if [[ "$version" == *Ver:* ]]; then
    printf '%s\n' "$version"
  else
    printf '%s\n' "$verbose"
  fi
}

emit_no_target() {
  cat <<'EOF'
{"protocol":"hdc","status":"needs_human","verdict":"inconclusive","reason":"no_hdc_target","message":"No OpenHarmony device or emulator is reachable. Use hdc tconn host:port or a host-mapped device. Do not invent device results from HAP unzip or host narration.","targets":[]}
EOF
}

list_targets() {
  require_hdc
  local raw cleaned
  raw="$("$hdc_bin" list targets 2>&1 || true)"
  cleaned="$(printf '%s' "$raw" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -Ev -e '^$' -e '^\[Empty\]$' -e '[Ff]ail' -e '[Ee]rror' -e '[Cc]onnect server' || true)"
  if [[ -z "$cleaned" ]]; then
    emit_no_target
    return 2
  fi
  printf '%s\n' "$cleaned" | jq -R -s '{protocol:"hdc",status:"ok",targets:[split("\n")[] | gsub("^\\s+|\\s+$";"") | select(length>0)]}'
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  smoke_version
  if [[ -f /opt/deepsonar/tool-manifest.json ]]; then
    jq -e '
      .contract == "deepsonar.runtime.contract/v1" and
      .imageKey == "deepsonar-mobile" and
      .device.openharmony.protocol == "hdc"
    ' /opt/deepsonar/tool-manifest.json >/dev/null
  fi
  printf 'OpenHarmony hdc 环境检查通过：hdc version / hdc -v 已就绪（不要求真机）\n'
  exit 0
fi

if [[ "${1:-}" == "targets" && $# -eq 1 ]]; then
  list_targets
  exit $?
fi

if [[ "${1:-}" == "--" && $# -gt 1 ]]; then
  require_hdc
  shift
  exec "$hdc_bin" "$@"
fi

usage >&2
exit 2
