#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo '用法：chrome-fuzz-toolchain-preflight.sh <target-arch> <gn-output-dir>' >&2
  exit 2
fi

target_arch="$1"
out_dir="$2"

case "$target_arch" in
  amd64) expected_host_arch='x86_64'; expected_file_arch='x86-64' ;;
  arm64) expected_host_arch='aarch64'; expected_file_arch='ARM aarch64' ;;
  *) echo "unsupported target architecture: $target_arch" >&2; exit 1 ;;
esac

host_arch="$(uname -m)"
[[ "$host_arch" == "$expected_host_arch" ]] || {
  echo "Chrome Fuzz toolchain preflight failed: target $target_arch is running on host $host_arch" >&2
  exit 1
}

commands_file="$(mktemp)"
trap 'rm -f -- "$commands_file"' EXIT

# GN has already generated this graph. Inspect Ninja's real command lines rather
# than trusting CC/CXX, which V8's GN toolchain does not use to select clang.
ninja_bin=/usr/bin/ninja
[[ -x "$ninja_bin" ]] || {
  echo "Chrome Fuzz toolchain preflight failed: native system Ninja is missing: $ninja_bin" >&2
  exit 1
}
ninja_format="$(file -Lb "$ninja_bin")"
[[ "$ninja_format" == *"$expected_file_arch"* ]] || {
  echo "Chrome Fuzz toolchain preflight failed: $ninja_bin is $ninja_format, expected $expected_file_arch" >&2
  exit 1
}
"$ninja_bin" --version >/dev/null
"$ninja_bin" -C "$out_dir" -t commands d8 v8_json_libfuzzer >"$commands_file"
compiler_token="$(grep -m1 -oE '(^|[[:space:]])[^[:space:]]*clang\+\+' "$commands_file" | sed 's/^[[:space:]]*//' || true)"
[[ -n "$compiler_token" ]] || {
  echo 'Chrome Fuzz toolchain preflight failed: GN emitted no clang++ command' >&2
  exit 1
}

if [[ "$compiler_token" = /* ]]; then
  compiler_path="$compiler_token"
else
  compiler_path="$(cd "$out_dir" && realpath -m "$compiler_token")"
fi

[[ -x "$compiler_path" ]] || {
  echo "Chrome Fuzz toolchain preflight failed: GN compiler is not executable: $compiler_path" >&2
  exit 1
}

compiler_format="$(file -Lb "$compiler_path")"
[[ "$compiler_format" == *"$expected_file_arch"* ]] || {
  echo "Chrome Fuzz toolchain preflight failed: $compiler_path is $compiler_format, expected $expected_file_arch" >&2
  exit 1
}

if [[ "$target_arch" == arm64 ]]; then
  [[ "$compiler_path" == /usr/lib/llvm-16/bin/clang++ ]] || {
    echo "Chrome Fuzz toolchain preflight failed: arm64 GN selected $compiler_path instead of /usr/lib/llvm-16/bin/clang++" >&2
    exit 1
  }
fi

"$compiler_path" --version >/dev/null
printf 'Chrome Fuzz toolchain preflight passed: target=%s host=%s compiler=%s (%s)\n' \
  "$target_arch" "$host_arch" "$compiler_path" "$compiler_format"
