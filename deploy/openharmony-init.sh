#!/usr/bin/env bash
set -euo pipefail

manifest="https://gitcode.com/openharmony/manifest.git"
branch="master"
group=""
manifest_file=""
jobs="$(nproc)"
source_dir="${OPENHARMONY_SOURCE_DIR:-/workspace/openharmony}"

usage() {
  cat <<'EOF'
用法：openharmony-init.sh [选项]

从官方 GitCode manifest 初始化并同步 OpenHarmony 源码。
选项：
  --manifest URL       manifest 仓库，默认 https://gitcode.com/openharmony/manifest.git
  --branch NAME        分支，默认 master
  --group NAME         repo group，可重复指定
  --manifest-file NAME manifest 文件名
  --jobs NUMBER        repo sync 并发数，默认使用 CPU 数
  --source-dir PATH    源码根目录，默认 /workspace/openharmony
EOF
}

groups=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) [[ $# -ge 2 ]] || { echo '缺少 --manifest 参数值' >&2; exit 2; }; manifest="$2"; shift 2 ;;
    --branch) [[ $# -ge 2 ]] || { echo '缺少 --branch 参数值' >&2; exit 2; }; branch="$2"; shift 2 ;;
    --group) [[ $# -ge 2 ]] || { echo '缺少 --group 参数值' >&2; exit 2; }; groups+=("$2"); shift 2 ;;
    --manifest-file) [[ $# -ge 2 ]] || { echo '缺少 --manifest-file 参数值' >&2; exit 2; }; manifest_file="$2"; shift 2 ;;
    --jobs) [[ $# -ge 2 ]] || { echo '缺少 --jobs 参数值' >&2; exit 2; }; jobs="$2"; shift 2 ;;
    --source-dir) [[ $# -ge 2 ]] || { echo '缺少 --source-dir 参数值' >&2; exit 2; }; source_dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$manifest" == https://* ]] || { echo 'manifest 必须使用 HTTPS URL' >&2; exit 2; }
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { echo 'jobs 必须是正整数' >&2; exit 2; }
mkdir -p "$source_dir"
cd "$source_dir"

repo_args=(repo init -u "$manifest" -b "$branch")
if ((${#groups[@]} > 0)); then
  group_value="$(IFS=,; printf '%s' "${groups[*]}")"
  repo_args+=(-g "$group_value")
fi
[[ -z "$manifest_file" ]] || repo_args+=(-m "$manifest_file")
"${repo_args[@]}"
repo sync --jobs="$jobs" --fail-fast
printf 'OpenHarmony 源码已初始化并同步：%s\n' "$source_dir"
