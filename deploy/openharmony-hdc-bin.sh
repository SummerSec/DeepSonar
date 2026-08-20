#!/usr/bin/env bash
set -euo pipefail
hdc_home="${HDC_HOME:-/opt/deepsonar/hdc}"
hdc_bin="${hdc_home}/hdc"
export LD_LIBRARY_PATH="${hdc_home}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [[ ! -x "$hdc_bin" ]]; then
  printf 'hdc 未安装：缺少 %s\n' "$hdc_bin" >&2
  exit 127
fi
machine="$(uname -m)"
if [[ "$machine" == "aarch64" || "$machine" == "arm64" ]]; then
  exec qemu-x86_64-static "$hdc_bin" "$@"
fi
exec "$hdc_bin" "$@"
