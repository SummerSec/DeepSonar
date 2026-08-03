#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：openharmony-env.sh --check

检查 OpenHarmony 源码同步与构建所需的工具，不会下载源码。
EOF
}

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

required_commands=(git git-lfs repo python3 cmake ninja ccache node claude)
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
printf 'OpenHarmony 环境检查通过：源码同步与构建工具已就绪\n'
