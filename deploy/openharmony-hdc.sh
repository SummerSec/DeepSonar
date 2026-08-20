#!/usr/bin/env bash
set -euo pipefail

hdc_bin="${HDC_BIN:-hdc}"

usage() {
  cat <<'EOF'
用法：openharmony-hdc.sh --check | targets | -- hdc-args...

OpenHarmony 设备协议入口（hdc）。动态证据必须来自 hdc 目标，禁止用主机叙述冒充设备结果。

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
  # Same qemu/no-daemon split as openharmony-env.sh: one command may only
  # print "Connect server failed"; pass if either reports Ver:.
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
{"protocol":"hdc","status":"needs_human","verdict":"inconclusive","reason":"no_hdc_target","message":"No OpenHarmony device or emulator is reachable. Use hdc tconn host:port or a host-mapped device. Do not invent device results from host narration.","targets":[]}
EOF
}

list_targets() {
  require_hdc
  local raw cleaned
  raw="$("$hdc_bin" list targets 2>&1 || true)"
  cleaned="$(printf '%s' "$raw" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ -z "$cleaned" || "$cleaned" == "[Empty]" ]]; then
    emit_no_target
    return 2
  fi
  python3 - "$cleaned" <<'PY'
import json, sys
raw = sys.argv[1]
targets = [line.strip() for line in raw.splitlines() if line.strip() and line.strip() != "[Empty]"]
print(json.dumps({"protocol": "hdc", "status": "ok", "targets": targets}, ensure_ascii=False))
if not targets:
    raise SystemExit(2)
PY
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  smoke_version
  if [[ -f /opt/deepsonar/tool-manifest.json ]]; then
    python3 - <<'PY'
import json
from pathlib import Path
m = json.loads(Path("/opt/deepsonar/tool-manifest.json").read_text())
assert m.get("contract") == "deepsonar.runtime.contract/v1"
assert m.get("imageKey") == "deepsonar-openharmony-test"
assert m.get("device", {}).get("protocol") == "hdc"
PY
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
