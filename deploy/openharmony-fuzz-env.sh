#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：openharmony-fuzz-env.sh --check [--static]

检查 OpenHarmony 动态验证 / Fuzz 工具链，不会下载源码或启动 fuzz 任务。
默认会运行一次 ASan/UBSan + libFuzzer 冒烟；--static 只编译并静态检查
冒烟可执行文件，适用于 amd64 主机经 QEMU 检查 arm64 镜像。
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
  afl-fuzz afl-clang-fast afl-clang-fast++
  gdb objdump addr2line file readelf
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

manifest_path=/opt/deepsonar/tool-manifest.json
if [[ ! -s "$manifest_path" ]]; then
  printf 'Fuzz 环境检查失败：缺少 runtime tool manifest %s\n' "$manifest_path" >&2
  exit 1
fi
node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (m.contract !== "deepsonar.runtime.contract/v1" || m.toolset !== "openharmony-fuzz" || m.imageKey !== "deepsonar-openharmony-fuzz" || m.entrypoints?.check !== "/opt/deepsonar/bin/openharmony-fuzz-env.sh") process.exit(1)' "$manifest_path"

smoke_binary=/tmp/deepsonar-libfuzzer-smoke
trap 'rm -f "$smoke_binary"' EXIT
printf 'int LLVMFuzzerTestOneInput(const unsigned char *d, unsigned long n){(void)d;(void)n;return 0;}\n' \
  | clang -x c - -O1 -g -fno-omit-frame-pointer -fsanitize=fuzzer,address,undefined -o "$smoke_binary"
if [[ ! -x "$smoke_binary" ]]; then
  printf 'Fuzz 环境检查失败：sanitizer 冒烟不是可执行文件\n' >&2
  exit 1
fi
if [[ "$check_mode" == "static" ]]; then
  # 只读取 ELF 元数据；不要在 QEMU 下启动 sanitizer-instrumented target。
  elf_header="$(readelf -h "$smoke_binary")"
  if ! grep -Eq 'Class:[[:space:]]+ELF64' <<<"$elf_header" || ! grep -Eq 'Type:[[:space:]]+(DYN|EXEC)' <<<"$elf_header"; then
    printf 'Fuzz 环境检查失败：sanitizer 冒烟 ELF 头不符合预期\n' >&2
    exit 1
  fi
  case "$runtime_arch" in
    x86_64)
      expected_machine="Advanced Micro Devices X86-64"
      ;;
    aarch64)
      expected_machine="AArch64"
      ;;
  esac
  if ! grep -Eq "Machine:[[:space:]]+$expected_machine" <<<"$elf_header"; then
    printf 'Fuzz 环境检查失败：sanitizer 冒烟架构不匹配（target=%s）\n' "$clang_target" >&2
    exit 1
  fi
  file_description="$(file "$smoke_binary")"
  if ! grep -Fq 'ELF 64-bit' <<<"$file_description"; then
    printf 'Fuzz 环境检查失败：sanitizer 冒烟不是 64 位 ELF（%s）\n' "$file_description" >&2
    exit 1
  fi
  symbol_table="$(readelf -Ws "$smoke_binary")"
  if ! grep -Eq '[[:space:]]__asan_init($|[[:space:]])' <<<"$symbol_table"; then
    printf 'Fuzz 环境检查失败：sanitizer 冒烟缺少 ASan 初始化符号\n' >&2
    exit 1
  fi
  if ! grep -Eq '[[:space:]]LLVMFuzzerRunDriver($|[[:space:]])' <<<"$symbol_table"; then
    printf 'Fuzz 环境检查失败：sanitizer 冒烟缺少 libFuzzer 驱动符号\n' >&2
    exit 1
  fi
else
  ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1 "$smoke_binary" -runs=1
fi
afl-fuzz -h >/dev/null 2>&1 || true
afl-clang-fast --version >/dev/null
gdb --version >/dev/null
if [[ "$check_mode" == "static" ]]; then
  printf 'OpenHarmony Fuzz 环境检查通过：libFuzzer 与 AFL++ 工具链已就绪（静态 ELF 检查，未执行 sanitizer 冒烟）\n'
else
  printf 'OpenHarmony Fuzz 环境检查通过：libFuzzer 与 AFL++ 工具链已就绪（动态 sanitizer 冒烟）\n'
fi
