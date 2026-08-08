#!/usr/bin/env bash
# Static-only Chrome/C++ audit helper. It supports a shallow partial clone and
# never evaluates repository content as shell code.
set -euo pipefail

repo_url=""
ref=""
target_path=""
source_dir="${CHROME_SOURCE_DIR:-/workspace/chrome-source}"
build_dir=""
mode="all"

usage() {
  cat <<'EOF'
用法：chrome-audit-scan.sh --path PATH [选项]

  --repo URL          可选；使用受限 HTTPS partial clone 准备源码
  --ref REF           partial clone 分支或 tag，默认 main
  --path PATH         源码相对路径或已存在的绝对路径（必填）
  --source-dir PATH   clone 目标目录，默认 /workspace/chrome-source
  --build-dir PATH    已有 compile_commands.json 的构建目录（可选）
  --mode MODE         all | semgrep | clang-tidy | binutils（默认 all）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) [[ $# -ge 2 ]] || { echo '缺少 --repo 参数值' >&2; exit 2; }; repo_url="$2"; shift 2 ;;
    --ref) [[ $# -ge 2 ]] || { echo '缺少 --ref 参数值' >&2; exit 2; }; ref="$2"; shift 2 ;;
    --path) [[ $# -ge 2 ]] || { echo '缺少 --path 参数值' >&2; exit 2; }; target_path="$2"; shift 2 ;;
    --source-dir) [[ $# -ge 2 ]] || { echo '缺少 --source-dir 参数值' >&2; exit 2; }; source_dir="$2"; shift 2 ;;
    --build-dir) [[ $# -ge 2 ]] || { echo '缺少 --build-dir 参数值' >&2; exit 2; }; build_dir="$2"; shift 2 ;;
    --mode) [[ $# -ge 2 ]] || { echo '缺少 --mode 参数值' >&2; exit 2; }; mode="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$target_path" ]] || { echo '--path 必填' >&2; usage >&2; exit 2; }
case "$mode" in all|semgrep|clang-tidy|binutils) ;; *) echo '--mode 无效' >&2; exit 2 ;; esac

if [[ -n "$repo_url" ]]; then
  [[ "$repo_url" == https://* ]] || { echo '--repo 必须使用 HTTPS' >&2; exit 2; }
  [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ || -z "$ref" ]] || { echo '--ref 含非法字符' >&2; exit 2; }
  ref="${ref:-main}"
  rm -rf -- "$source_dir"
  git clone --filter=blob:none --no-checkout --depth 1 --branch "$ref" "$repo_url" "$source_dir"
  git -C "$source_dir" sparse-checkout init --cone
  git -C "$source_dir" sparse-checkout set --no-cone "$target_path"
  git -C "$source_dir" checkout --detach
  target_path="$source_dir/$target_path"
elif [[ "$target_path" != /* ]]; then
  target_path="$source_dir/$target_path"
fi

[[ -d "$target_path" || -f "$target_path" ]] || { printf '找不到审计路径：%s\n' "$target_path" >&2; exit 1; }

run_semgrep() {
  semgrep --config /opt/deepsonar/chrome-audit-rules.yml --json --metrics=off "$target_path"
}

run_clang_tidy() {
  if [[ -n "$build_dir" && -f "$build_dir/compile_commands.json" ]]; then
    clang-tidy -p "$build_dir" "$target_path" --quiet
    return
  fi
  mapfile -t sources < <(find "$target_path" -type f \( -name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.cxx' \) -print | sort | head -n 200)
  if ((${#sources[@]} == 0)); then
    echo '{"status":"inconclusive","reason":"no C/C++ source files selected"}'
    return 0
  fi
  clang-tidy "${sources[@]}" --quiet -- -I"$target_path"
}

run_binutils() {
  find "$target_path" -type f -size +0c -print0 \
    | xargs -0 -r -n 1 file --brief --dereference \
    | sed -n '1,200p'
}

case "$mode" in
  semgrep) run_semgrep ;;
  clang-tidy) run_clang_tidy ;;
  binutils) run_binutils ;;
  all)
    run_semgrep
    run_clang_tidy
    run_binutils
    ;;
esac
