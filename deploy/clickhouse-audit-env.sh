#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：clickhouse-audit-env.sh --check

ClickHouse Audit 只提供 git、CMake/Ninja、Clang/LLVM 与 binutils 等基础工具；不预装决策扫描器，也不提供平台固定扫描入口。
EOF
}

check_manifest() {
  [[ -s /opt/deepsonar/tool-manifest.json ]]
  jq -e '
    .contract == "deepsonar.runtime.contract/v1" and
    .imageKey == "deepsonar-clickhouse-audit" and
    (.tools | index("git")) and
    (.tools | index("clang")) and
    (.tools | index("clang-tidy")) and
    (.tools | index("cmake")) and
    (.tools | index("ninja")) and
    (.tools | index("objdump")) and
    (.tools | index("jq")) and
    (.tools | index("node")) and
    (.tools | index("claude"))
  ' /opt/deepsonar/tool-manifest.json >/dev/null
}

check_tools() {
  local command_name
  for command_name in git clang clang++ clang-tidy clangd cmake ninja objdump readelf llvm-nm jq node claude; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'ClickHouse Audit 环境检查失败：缺少命令 %s\n' "$command_name" >&2
      return 1
    }
  done
  git --version >/dev/null
  clang --version >/dev/null
  clang-tidy --version >/dev/null
  clangd --version >/dev/null
  cmake --version >/dev/null
  ninja --version >/dev/null
  objdump --version >/dev/null
  jq --version >/dev/null
  node --version >/dev/null
  claude --version >/dev/null
  for command_name in semgrep gitleaks shellcheck; do
    if command -v "$command_name" >/dev/null 2>&1; then
      printf 'ClickHouse Audit 不得预装决策扫描器 %s\n' "$command_name" >&2
      return 1
    fi
  done
  check_manifest
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  check_tools
  printf 'ClickHouse Audit 环境检查通过：git、CMake/Ninja、Clang/LLVM、binutils、jq 与 Claude Code 已就绪\n'
  exit 0
fi

usage >&2
exit 2
