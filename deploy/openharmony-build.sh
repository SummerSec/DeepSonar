#!/usr/bin/env bash
set -euo pipefail

source_dir="${OPENHARMONY_SOURCE_DIR:-/workspace/openharmony}"
product_name=""
build_args=()

usage() {
  cat <<'EOF'
用法：openharmony-build.sh --product-name NAME [构建参数]

在 OpenHarmony 源码根目录调用 ./build.sh。除 --product-name 外的参数会原样传递。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --product-name) [[ $# -ge 2 ]] || { echo '缺少 --product-name 参数值' >&2; exit 2; }; product_name="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) build_args+=("$1"); shift ;;
  esac
done

[[ -n "$product_name" ]] || { echo '必须指定 --product-name' >&2; usage >&2; exit 2; }
[[ -d "$source_dir" ]] || { printf '找不到源码目录：%s\n' "$source_dir" >&2; exit 1; }
[[ -x "$source_dir/build.sh" ]] || { printf '源码根目录缺少可执行 ./build.sh：%s\n' "$source_dir" >&2; exit 1; }

cd "$source_dir"
exec ./build.sh --product-name "$product_name" "${build_args[@]}"
