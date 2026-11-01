#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：openharmony-fuzz-env.sh --check [--static]

检查 OpenHarmony 动态验证 / Fuzz 工具链，不会下载源码或启动 fuzz 任务。
默认会运行 ASan/UBSan + libFuzzer 和 AFL++ 冒烟；--static 只编译并静态检查
两个冒烟可执行文件，适用于 amd64 主机经 QEMU 检查 arm64 镜像。
EOF
}

if [[ "${1:-}" != "--check" || $# -gt 2 || ( $# -eq 2 && "${2:-}" != "--static" ) ]]; then
  usage >&2
  exit 2
fi

check_mode="dynamic"
if [[ $# -eq 2 ]]; then
  check_mode="static"
fi

required_commands=(
  git git-lfs repo python3 cmake ninja ccache
  clang clang++ llvm-symbolizer
  afl-fuzz afl-clang-fast afl-clang-fast++ afl-showmap
  gdb objdump addr2line file readelf
  node claude
)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '环境检查失败：缺少命令 %s\n' "$command_name" >&2
    exit 1
  fi
done

for compiler in clang clang++ afl-clang-fast afl-clang-fast++; do
  compiler_version="$("$compiler" --version)"
  printf '%s: %s\n' "$compiler" "$compiler_version"
  if ! grep -Eq 'clang version 19\.' <<<"$compiler_version"; then
    printf 'Fuzz 环境检查失败：%s 未使用匹配的 LLVM 19\n' "$compiler" >&2
    exit 1
  fi
done
llvm-symbolizer --version
# The matched Debian compiler-rt is under Clang's actual resource directory;
# neither a GCC libasan package nor a newer CC alias fixes an old AFL plugin.
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
if [[ "$resource_dir" != /usr/lib/llvm-19/lib/clang/19* || "$(afl-clang-fast++ -print-resource-dir)" != "$resource_dir" ]]; then
  printf 'Fuzz 环境检查失败：Clang 与 AFL++ compiler-rt 不匹配\n' >&2
  exit 1
fi
runtime_dir="$resource_dir/lib/linux"
if [[ ! -d "$runtime_dir" ]]; then
  printf 'Fuzz 环境检查失败：Clang resource dir 缺少 %s\n' "$runtime_dir" >&2
  exit 1
fi
for runtime_name in asan fuzzer fuzzer_interceptors ubsan_standalone; do
  runtime_path="$runtime_dir/libclang_rt.${runtime_name}-${runtime_arch}.a"
  if [[ ! -s "$runtime_path" ]]; then
    printf 'Fuzz 环境检查失败：缺少 compiler-rt 归档 %s (resource=%s target=%s)\n' \
      "libclang_rt.${runtime_name}-${runtime_arch}.a" "$resource_dir" "$clang_target" >&2
    exit 1
  fi
done

manifest_path=/opt/deepsonar/tool-manifest.json
if [[ ! -s "$manifest_path" ]]; then
  printf 'Fuzz 环境检查失败：缺少 runtime tool manifest %s\n' "$manifest_path" >&2
  exit 1
fi
node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (m.contract !== "deepsonar.runtime.contract/v1" || m.toolset !== "openharmony-fuzz" || m.imageKey !== "deepsonar-openharmony-fuzz" || m.entrypoints?.check !== "/opt/deepsonar/bin/openharmony-fuzz-env.sh") process.exit(1)' "$manifest_path"

work="$(mktemp -d /tmp/deepsonar-oh-env-XXXXXX)"
cleanup() {
  local status=$? resolved
  resolved="$(realpath -- "$work")"
  if [[ "$resolved" != "$work" || ! "$resolved" =~ ^/tmp/deepsonar-oh-env-[[:alnum:]]{6}$ ]]; then
    printf '拒绝清理不匹配的临时路径\n' >&2
    exit 1
  fi
  rm -rf -- "$resolved"
  exit "$status"
}
trap cleanup EXIT
smoke_binary="$work/libfuzzer"
afl_binary="$work/afl"
printf 'int LLVMFuzzerTestOneInput(const unsigned char *d, unsigned long n){(void)d;(void)n;return 0;}\n' \
  | clang -x c - -O1 -g -fno-omit-frame-pointer -fsanitize=fuzzer,address,undefined -o "$smoke_binary"
printf 'int main(void){return 0;}\n' > "$work/afl.cc"
/opt/deepsonar/bin/openharmony-fuzz-build.sh --engine afl --source "$work/afl.cc" --output "$afl_binary"
case "$runtime_arch" in
  x86_64) expected_machine="Advanced Micro Devices X86-64" ;;
  aarch64) expected_machine="AArch64" ;;
esac
# 只读取 ELF 元数据；--static 不在 QEMU 下执行任一 sanitizer target。
for binary in "$smoke_binary" "$afl_binary"; do
  elf_header="$(readelf -h "$binary")"
  file_description="$(file "$binary")"
  if ! grep -Eq 'Class:[[:space:]]+ELF64' <<<"$elf_header" \
    || ! grep -Eq 'Type:[[:space:]]+DYN' <<<"$elf_header" \
    || ! grep -Eq "Machine:[[:space:]]+$expected_machine" <<<"$elf_header" \
    || ! grep -Fq 'ELF 64-bit' <<<"$file_description"; then
    printf 'Fuzz 环境检查失败：sanitizer 冒烟须为当前 target 的 64 位 PIE ELF\n' >&2
    exit 1
  fi
  symbol_table="$(readelf -Ws "$binary")"
  if ! grep -Eq '[[:space:]]__asan_init($|[[:space:]])' <<<"$symbol_table"; then
    printf 'Fuzz 环境检查失败：sanitizer 冒烟缺少 ASan 初始化符号\n' >&2
    exit 1
  fi
  if [[ "$binary" == "$smoke_binary" ]]; then
    expected_symbol=LLVMFuzzerRunDriver
  else
    expected_symbol=__afl_area_ptr
  fi
  if ! grep -Eq "[[:space:]]$expected_symbol($|[[:space:]])" <<<"$symbol_table"; then
    printf 'Fuzz 环境检查失败：缺少 engine 符号 %s\n' "$expected_symbol" >&2
    exit 1
  fi
done
if [[ "$check_mode" == "static" ]]; then
  printf 'OpenHarmony Fuzz 环境检查通过：两种 engine 的静态 ELF 检查，未执行 sanitizer 冒烟\n'
else
  ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 "$smoke_binary" -runs=1
  ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 "$afl_binary"
  printf 'OpenHarmony Fuzz 环境检查通过：两种 engine 的动态 sanitizer 冒烟\n'
fi
