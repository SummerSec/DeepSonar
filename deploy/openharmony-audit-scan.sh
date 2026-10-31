#!/usr/bin/env bash
# OpenHarmony 高危静态审计辅助入口：生成 compile_commands 并跑 clang-tidy / cppcheck。
# 不做自动“定级”；Finding 由 Agent 据结果自行结构化上报。
set -euo pipefail

source_dir="${OPENHARMONY_SOURCE_DIR:-/workspace/openharmony}"
target_path=""
jobs="$(nproc 2>/dev/null || echo 2)"
mode="all"
build_dir=""

usage() {
  cat <<'EOF'
用法：openharmony-audit-scan.sh --path REL_OR_ABS [选项]

在已同步的 OpenHarmony 源码树上对指定子树做静态检查。

  --path PATH          相对 source-dir 或绝对路径（必填）
  --source-dir PATH    源码根，默认 $OPENHARMONY_SOURCE_DIR 或 /workspace/openharmony
  --build-dir PATH     已有 CMake/Ninja 构建目录（可选；有则优先用其 compile_commands.json）
  --mode MODE          all | tidy | cppcheck | sparse（默认 all）
  --jobs N             并行度（默认 nproc）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) target_path="${2:-}"; shift 2 ;;
    --source-dir) source_dir="${2:-}"; shift 2 ;;
    --build-dir) build_dir="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --jobs) jobs="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$target_path" ]]; then
  usage >&2
  exit 2
fi

if [[ "$target_path" != /* ]]; then
  target_path="${source_dir%/}/$target_path"
fi
if [[ ! -e "$target_path" ]]; then
  printf '目标路径不存在：%s\n' "$target_path" >&2
  exit 1
fi

case "$mode" in
  all|tidy|cppcheck|sparse) ;;
  *) printf '无效 --mode：%s\n' "$mode" >&2; exit 2 ;;
esac

out_dir="/workspace/oh-audit-out"
mkdir -p "$out_dir"
compile_db=""

if [[ -n "$build_dir" && -f "$build_dir/compile_commands.json" ]]; then
  compile_db="$build_dir/compile_commands.json"
elif [[ -f "$source_dir/compile_commands.json" ]]; then
  compile_db="$source_dir/compile_commands.json"
fi

run_tidy() {
  if [[ -z "$compile_db" ]]; then
    printf '跳过 clang-tidy：未找到 compile_commands.json（可用 --build-dir 或 bear 生成）\n' >&2
    return 0
  fi
  local list_file="$out_dir/tidy-files.txt"
  if [[ -d "$target_path" ]]; then
    find "$target_path" -type f \( -name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.cxx' \) >"$list_file"
  else
    printf '%s\n' "$target_path" >"$list_file"
  fi
  if [[ ! -s "$list_file" ]]; then
    printf 'clang-tidy：目标下无 C/C++ 源文件\n' >&2
    return 0
  fi
  # 聚焦历史高危类：内存安全、空指针、越界、use-after 相关检查组。
  local checks='clang-analyzer-*,bugprone-*,clang-diagnostic-*,-clang-analyzer-security.insecureAPI.*'
  while IFS= read -r src; do
    clang-tidy -p "$(dirname "$compile_db")" -checks="$checks" "$src" \
      >>"$out_dir/clang-tidy.log" 2>&1 || true
  done <"$list_file"
  printf 'clang-tidy 输出：%s\n' "$out_dir/clang-tidy.log"
}

run_cppcheck() {
  local args=(--enable=warning,style,performance,portability --inconclusive --force -j "$jobs"
    --output-file="$out_dir/cppcheck.txt")
  if [[ -n "$compile_db" ]]; then
    args+=(--project="$compile_db")
  fi
  cppcheck "${args[@]}" "$target_path" >/dev/null 2>&1 || true
  printf 'cppcheck 输出：%s\n' "$out_dir/cppcheck.txt"
}

run_sparse() {
  # sparse 适合内核风格 C；对单文件/目录尽力扫描。
  local list_file="$out_dir/sparse-files.txt"
  if [[ -d "$target_path" ]]; then
    find "$target_path" -type f -name '*.c' >"$list_file"
  else
    printf '%s\n' "$target_path" >"$list_file"
  fi
  : >"$out_dir/sparse.log"
  while IFS= read -r src; do
    sparse -Wsparse-all "$src" >>"$out_dir/sparse.log" 2>&1 || true
  done <"$list_file"
  printf 'sparse 输出：%s\n' "$out_dir/sparse.log"
}

case "$mode" in
  all)
    run_tidy
    run_cppcheck
    run_sparse
    ;;
  tidy) run_tidy ;;
  cppcheck) run_cppcheck ;;
  sparse) run_sparse ;;
esac

printf 'OpenHarmony 静态审计完成，结果目录：%s\n' "$out_dir"
