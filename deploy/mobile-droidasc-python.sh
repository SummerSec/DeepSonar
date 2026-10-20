#!/usr/bin/env bash
# droidasc-python：Python Droid ASC（PyPI droidasc，MG1937/ASC）的显式回退入口。
# 默认入口 droidasc / rust_ASC 运行 Rust 实现；只有调用方明确选择本入口时才执行 Python 版本。
# 每次调用向 stderr 写一行实现/版本/参数记录；退出码和 stdout/stderr 原样透传。不允许 GUI 模式。
set -euo pipefail

droidasc_python_home="${DROIDASC_PYTHON_HOME:-/opt/deepsonar/droidasc-python}"
droidasc_python_bin="${DROIDASC_PYTHON_BIN:-/opt/deepsonar/mobile-venv/bin/droidasc}"
droidasc_python_buildinfo="${DROIDASC_PYTHON_BUILDINFO:-${droidasc_python_home}/BUILDINFO}"

if [[ ! -x "$droidasc_python_bin" ]]; then
  printf 'droidasc-python: Python ASC 未安装：缺少 %s\n' "$droidasc_python_bin" >&2
  exit 127
fi
if [[ ! -s "$droidasc_python_buildinfo" ]]; then
  printf 'droidasc-python: 缺少 Python ASC 安装记录 %s\n' "$droidasc_python_buildinfo" >&2
  exit 127
fi

impl_version=""
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == version=* ]]; then
    impl_version="${line#version=}"
    break
  fi
done <"$droidasc_python_buildinfo"
if [[ -z "$impl_version" ]]; then
  printf 'droidasc-python: 安装记录缺少 version：%s\n' "$droidasc_python_buildinfo" >&2
  exit 127
fi

if [[ $# -eq 1 && "$1" == "--impl-info" ]]; then
  printf 'entry=droidasc-python\n'
  cat "$droidasc_python_buildinfo"
  exit 0
fi

for arg in "$@"; do
  [[ "$arg" == "--" ]] && break
  case "$arg" in
    --gui|--gui=*|--gui-foreground)
      printf 'droidasc-python: GUI 模式在 DeepSonar 镜像中不可用\n' >&2
      exit 2
      ;;
  esac
done

printf 'droidasc-python: implementation=droidasc-python version=%s argv=' "$impl_version" >&2
if (( $# > 0 )); then
  printf '%q ' "$@" >&2
fi
printf '\n' >&2
exec "$droidasc_python_bin" "$@"
