#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：chrome-audit-env.sh --check

Chrome Audit 只提供 git、Clang/LLVM 与 binutils 等基础工具；不预装决策扫描器，也不提供平台固定扫描入口。
EOF
}

check_manifest() {
  [[ -s /opt/deepsonar/tool-manifest.json ]]
  jq -e '
    .contract == "deepsonar.runtime.contract/v1" and
    .imageKey == "deepsonar-chrome-audit" and
    (.tools | index("git")) and
    (.tools | index("clang")) and
    (.tools | index("clang-tidy")) and
    (.tools | index("objdump")) and
    (.tools | index("jq"))
  ' /opt/deepsonar/tool-manifest.json >/dev/null
}

check_tools() {
  local command_name
  for command_name in git clang clang++ clang-tidy clangd objdump readelf llvm-nm jq; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'Chrome Audit 环境检查失败：缺少命令 %s\n' "$command_name" >&2
      return 1
    }
  done
  git --version >/dev/null
  clang --version >/dev/null
  clang-tidy --version >/dev/null
  clangd --version >/dev/null
  objdump --version >/dev/null
  jq --version >/dev/null
  for command_name in semgrep gitleaks shellcheck; do
    if command -v "$command_name" >/dev/null 2>&1; then
      printf 'Chrome Audit 不得预装决策扫描器 %s\n' "$command_name" >&2
      return 1
    fi
  done
  check_manifest
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  check_tools
  printf 'Chrome Audit 环境检查通过：git、Clang/LLVM、binutils 与 jq 已就绪\n'
  exit 0
fi

usage >&2
exit 2
