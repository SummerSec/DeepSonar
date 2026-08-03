#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：openharmony-audit-env.sh --check

检查 OpenHarmony 高危静态审计工具链，不会下载源码或执行扫描。
EOF
}

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

required_commands=(
  git git-lfs repo python3 cmake ninja ccache
  clang clang++ clang-tidy scan-build
  llvm-symbolizer gdb objdump addr2line
  sparse cppcheck bear
  node claude
)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '环境检查失败：缺少命令 %s\n' "$command_name" >&2
    exit 1
  fi
done

clang --version >/dev/null
clang-tidy --version >/dev/null
scan-build --help >/dev/null
llvm-symbolizer --version >/dev/null
echo 'int main(void){return 0;}' \
  | clang -x c - -fsanitize=address,undefined -o /tmp/deepsonar-sanitizer-smoke
/tmp/deepsonar-sanitizer-smoke
rm -f /tmp/deepsonar-sanitizer-smoke
gdb --version >/dev/null
sparse --version >/dev/null
cppcheck --version >/dev/null
bear --version >/dev/null
printf 'OpenHarmony Audit 环境检查通过：静态分析与 Sanitizer 工具链已就绪\n'
