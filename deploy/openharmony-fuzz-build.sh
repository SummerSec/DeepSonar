#!/usr/bin/env bash
# 用 libFuzzer 或 AFL++ 编译单个 harness；不自动长时间 fuzz。
set -euo pipefail

engine="libfuzzer"
source_file=""
output="/workspace/oh-fuzz-out/harness"
extra_cflags=()
extra_ldflags=()

usage() {
  cat <<'EOF'
用法：openharmony-fuzz-build.sh --source FILE [选项]

  --source FILE        harness 源文件（必填，含 LLVMFuzzerTestOneInput 或 AFL main）
  --engine ENGINE      libfuzzer | afl（默认 libfuzzer）
  --output PATH        输出二进制，默认 /workspace/oh-fuzz-out/harness
  --cflags "FLAGS"     追加编译参数（可重复）
  --ldflags "FLAGS"    追加链接参数（可重复）

示例：
  openharmony-fuzz-build.sh --source harness.cc --engine libfuzzer
  openharmony-fuzz-build.sh --source harness.c --engine afl --cflags "-I$OPENHARMONY_SOURCE_DIR/..."
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_file="${2:-}"; shift 2 ;;
    --engine) engine="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --cflags) extra_cflags+=(${2:-}); shift 2 ;;
    --ldflags) extra_ldflags+=(${2:-}); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$source_file" || ! -f "$source_file" ]]; then
  printf '必须提供存在的 --source 文件\n' >&2
  usage >&2
  exit 2
fi

mkdir -p "$(dirname "$output")"
common_flags=(-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined)

case "$engine" in
  libfuzzer)
    clang++ "${common_flags[@]}" -fsanitize=fuzzer \
      "${extra_cflags[@]}" "$source_file" "${extra_ldflags[@]}" -o "$output"
    ;;
  afl)
    # AFL++ 快速插桩 + ASan；harness 需提供 main 或使用 afl 驱动。
    AFL_USE_ASAN=1 afl-clang-fast++ "${common_flags[@]}" \
      "${extra_cflags[@]}" "$source_file" "${extra_ldflags[@]}" -o "$output"
    ;;
  *)
    printf '无效 --engine：%s（支持 libfuzzer|afl）\n' "$engine" >&2
    exit 2
    ;;
esac

printf '已编译 fuzz harness：%s（engine=%s）\n' "$output" "$engine"
printf '短时冒烟（libFuzzer）：%s -runs=100 corpus_dir\n' "$output"
printf 'AFL++ 示例：afl-fuzz -i seeds -o findings -- %s @@\n' "$output"
