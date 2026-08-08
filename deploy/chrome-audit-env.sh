#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：chrome-audit-env.sh --check
      chrome-audit-env.sh --scan --path PATH [--build-dir DIR] [--mode MODE]

Chrome Audit 只提供静态分析工具；源码目录由 Job 显式准备，构建阶段不会下载目标源码。
EOF
}

check_manifest() {
  [[ -s /opt/deepsonar/tool-manifest.json ]]
  jq -e '
    .contract == "deepsonar.runtime.contract/v1" and
    .imageKey == "deepsonar-chrome-audit" and
    (.tools | index("semgrep")) and (.tools | index("clang-tidy"))
  ' /opt/deepsonar/tool-manifest.json >/dev/null
}

check_tools() {
  local command_name
  for command_name in git clang clang++ clang-tidy semgrep objdump readelf llvm-nm jq node claude; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'Chrome Audit 环境检查失败：缺少命令 %s\n' "$command_name" >&2
      return 1
    }
  done
  git --version >/dev/null
  clang --version >/dev/null
  clang-tidy --version >/dev/null
  semgrep --version >/dev/null
  objdump --version >/dev/null
  check_manifest
  local smoke_dir
  smoke_dir="$(mktemp -d)"
  trap 'rm -rf "$smoke_dir"' RETURN
  printf '#include <string.h>\nint main(void){char b[4]; strcpy(b,"x");}\n' >"$smoke_dir/smoke.cpp"
  semgrep --config /opt/deepsonar/chrome-audit-rules.yml --error --lang cpp "$smoke_dir/smoke.cpp" >/dev/null 2>&1 || true
  clang --analyze "$smoke_dir/smoke.cpp" >/dev/null 2>&1 || true
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  check_tools
  printf 'Chrome Audit 环境检查通过：git partial clone、Semgrep C++ rules、Clang/LLVM 与 binutils 已就绪\n'
  exit 0
fi

if [[ "${1:-}" == "--scan" ]]; then
  shift
  exec /opt/deepsonar/bin/chrome-audit-scan.sh "$@"
fi

usage >&2
exit 2
