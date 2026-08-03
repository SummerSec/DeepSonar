#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：openharmony-fuzz-env.sh --check

检查 OpenHarmony 动态验证 / Fuzz 工具链，不会下载源码或启动 fuzz 任务。
EOF
}

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

required_commands=(
  git git-lfs repo python3 cmake ninja ccache
  clang clang++ llvm-symbolizer
  afl-fuzz afl-clang-fast afl-clang-fast++
  gdb objdump addr2line
  node claude
)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '环境检查失败：缺少命令 %s\n' "$command_name" >&2
    exit 1
  fi
done

clang --version >/dev/null
# libFuzzer 随 Clang 提供，编译期用 -fsanitize=fuzzer 验证即可。
echo 'int LLVMFuzzerTestOneInput(const unsigned char *d, unsigned long n){(void)d;(void)n;return 0;}' \
  | clang -x c - -fsanitize=fuzzer -o /tmp/deepsonar-libfuzzer-smoke
rm -f /tmp/deepsonar-libfuzzer-smoke
afl-fuzz -h >/dev/null 2>&1 || true
afl-clang-fast --version >/dev/null
gdb --version >/dev/null
printf 'OpenHarmony Fuzz 环境检查通过：libFuzzer 与 AFL++ 工具链已就绪\n'
