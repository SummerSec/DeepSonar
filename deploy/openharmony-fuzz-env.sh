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
# Debian's libclang-rt-dev installs compiler-rt below Clang's resource
# directory. Keep this probe architecture-neutral: Debian names the runtime
# archives x86_64/aarch64, while the resource directory version is selected
# by the installed clang binary.
clang_target="$(clang -print-target-triple 2>/dev/null || true)"
if [[ -z "$clang_target" ]]; then
  clang_target="$(clang -dumpmachine)"
fi
case "${clang_target%%-*}" in
  x86_64|amd64) runtime_arch="x86_64" ;;
  aarch64|arm64) runtime_arch="aarch64" ;;
  *)
    printf 'Fuzz 环境检查失败：不支持的 Clang target %s\n' "$clang_target" >&2
    exit 1
    ;;
esac

resource_dir="$(clang -print-resource-dir)"
runtime_dir="$resource_dir/lib/linux"
if [[ ! -d "$runtime_dir" ]]; then
  printf 'Fuzz 环境检查失败：Clang resource dir 缺少 %s\n' "$runtime_dir" >&2
  exit 1
fi
for runtime_name in fuzzer fuzzer_interceptors ubsan_standalone; do
  runtime_path="$(find "$runtime_dir" -maxdepth 1 -type f -name "libclang_rt.${runtime_name}-${runtime_arch}.a" -print -quit)"
  if [[ -z "$runtime_path" ]]; then
    printf 'Fuzz 环境检查失败：缺少 compiler-rt 归档 %s (resource=%s target=%s)\n' \
      "libclang_rt.${runtime_name}-${runtime_arch}.a" "$resource_dir" "$clang_target" >&2
    exit 1
  fi
done

smoke_binary=/tmp/deepsonar-libfuzzer-smoke
trap 'rm -f "$smoke_binary"' EXIT
printf 'int LLVMFuzzerTestOneInput(const unsigned char *d, unsigned long n){(void)d;(void)n;return 0;}\n' \
  | clang -x c - -O1 -g -fno-omit-frame-pointer -fsanitize=fuzzer,address,undefined -o "$smoke_binary"
ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 "$smoke_binary" -runs=1
afl-fuzz -h >/dev/null 2>&1 || true
afl-clang-fast --version >/dev/null
gdb --version >/dev/null
printf 'OpenHarmony Fuzz 环境检查通过：libFuzzer 与 AFL++ 工具链已就绪\n'
