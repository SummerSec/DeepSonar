#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：openharmony-env.sh --check [--hdc]

检查 OpenHarmony 源码同步与构建所需的工具，不会下载源码。
Test 镜像再加 --hdc，冒烟官方 hdc version / hdc -v，不要求真机。
EOF
}

if [[ "${1:-}" != "--check" || $# -gt 2 ]]; then
  usage >&2
  exit 2
fi
require_hdc=0
if [[ $# -eq 2 ]]; then
  if [[ "$2" != "--hdc" ]]; then
    usage >&2
    exit 2
  fi
  require_hdc=1
fi

required_commands=(git git-lfs repo python3 cmake ninja ccache node claude)
if (( require_hdc )); then
  required_commands+=(hdc)
fi
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '环境检查失败：缺少命令 %s\n' "$command_name" >&2
    exit 1
  fi
done

git lfs version >/dev/null
repo --version >/dev/null
python3 --version >/dev/null
cmake --version >/dev/null
ninja --version >/dev/null
ccache --version >/dev/null
node --version >/dev/null
claude --version >/dev/null
if (( require_hdc )); then
  hdc_version="$(hdc version 2>&1 || true)"
  hdc_verbose="$(hdc -v 2>&1 || true)"
  # Official linux-x64 hdc under qemu (arm64 image) may print
  # "Connect server failed" on one of version/-v when no daemon exists,
  # and "Ver: …" on the other. Accept if either command reports a version.
  if [[ "${hdc_version}${hdc_verbose}" != *Ver:* ]]; then
    printf '环境检查失败：hdc version / hdc -v 无有效输出\n%s\n%s\n' "$hdc_version" "$hdc_verbose" >&2
    exit 1
  fi
  tool_manifest="${DEEPSONAR_TOOL_MANIFEST:-/opt/deepsonar/tool-manifest.json}"
  python3 - "$tool_manifest" <<'PY'
import json
import sys
from pathlib import Path
m = json.loads(Path(sys.argv[1]).read_text())
if m.get("contract") != "deepsonar.runtime.contract/v1" or m.get("imageKey") != "deepsonar-openharmony-test" or m.get("device", {}).get("protocol") != "hdc":
    raise SystemExit(1)
PY
  printf 'OpenHarmony 环境检查通过：源码同步、构建工具与官方 hdc 已就绪（不要求真机）\n'
else
  printf 'OpenHarmony 环境检查通过：源码同步与构建工具已就绪\n'
fi
