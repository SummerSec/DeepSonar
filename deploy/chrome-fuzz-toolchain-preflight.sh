#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo '用法：chrome-fuzz-toolchain-preflight.sh <target-arch> <gn-output-dir>' >&2
  exit 2
fi

target_arch="$1"
out_dir="$2"

case "$target_arch" in
  amd64) expected_target_flag='' ;;
  arm64) expected_target_flag='--target=aarch64-linux-gnu' ;;
  *) echo "unsupported target architecture: $target_arch" >&2; exit 1 ;;
esac

host_arch="$(uname -m)"
[[ "$host_arch" == x86_64 ]] || {
  echo "Chrome Fuzz toolchain preflight failed: pinned V8 Clang requires an x86_64 build host, got $host_arch" >&2
  exit 1
}

commands_file="$(mktemp)"
inputs_file="$(mktemp)"
runtime_refs_file="$(mktemp)"
trap 'rm -f -- "$commands_file" "$inputs_file" "$runtime_refs_file"' EXIT

# GN has already generated this graph. Inspect Ninja's real command lines rather
# than trusting CC/CXX, which V8's GN toolchain does not use to select clang.
ninja_bin=/usr/bin/ninja
[[ -x "$ninja_bin" ]] || {
  echo "Chrome Fuzz toolchain preflight failed: native system Ninja is missing: $ninja_bin" >&2
  exit 1
}
ninja_format="$(file -Lb "$ninja_bin")"
[[ "$ninja_format" == *x86-64* ]] || {
  echo "Chrome Fuzz toolchain preflight failed: $ninja_bin is $ninja_format, expected x86-64" >&2
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
[[ "$compiler_format" == *x86-64* ]] || {
  echo "Chrome Fuzz toolchain preflight failed: $compiler_path is $compiler_format, expected x86-64" >&2
  exit 1
}

[[ "$compiler_token" == *third_party/llvm-build/Release+Asserts/bin/clang++ ]] || {
  echo "Chrome Fuzz toolchain preflight failed: GN emitted non-pinned compiler $compiler_token" >&2
  exit 1
}
[[ "$compiler_path" == */third_party/llvm-build/Release+Asserts/bin/clang || "$compiler_path" == */third_party/llvm-build/Release+Asserts/bin/clang++ ]] || {
  echo "Chrome Fuzz toolchain preflight failed: GN selected non-pinned compiler $compiler_path" >&2
  exit 1
}

if [[ -n "$expected_target_flag" ]]; then
  grep -q -- "$expected_target_flag" "$commands_file" || {
    echo "Chrome Fuzz toolchain preflight failed: $target_arch commands omit $expected_target_flag" >&2
    exit 1
  }
fi

"$compiler_path" --version >/dev/null

# Check the generated graph's concrete compiler-rt inputs before Ninja starts
# scheduling compilation. This catches resource-directory mismatches (for
# example Debian's lib/linux layout versus Chromium's target-triple layout)
# without allowing a late linker failure to hide a bad GN contract.
"$ninja_bin" -C "$out_dir" -t inputs d8 v8_json_libfuzzer >"$inputs_file"
grep -E 'libclang_rt[.][^[:space:]]+' "$inputs_file" | sed 's/[[:space:]]*$//' | sort -u >"$runtime_refs_file" || true
[[ -s "$runtime_refs_file" ]] || {
  echo 'Chrome Fuzz toolchain preflight failed: GN/Ninja emitted no compiler-rt runtime inputs' >&2
  exit 1
}
grep -q 'libclang_rt[.]builtins' "$runtime_refs_file" || {
  echo 'Chrome Fuzz toolchain preflight failed: GN/Ninja emitted no compiler-rt builtins input' >&2
  exit 1
}
if grep -q 'libclang_rt[.]fuzzer' "$runtime_refs_file"; then
  echo 'Chrome Fuzz toolchain preflight failed: Debian libFuzzer archive entered the GN graph' >&2
  exit 1
fi
grep -q 'third_party/deepsonar-compiler-rt/compiler-rt/lib/fuzzer/FuzzerMain.cpp' "$inputs_file" || {
  echo 'Chrome Fuzz toolchain preflight failed: pinned compiler-rt/libFuzzer source is absent from the GN graph' >&2
  exit 1
}
while IFS= read -r runtime_ref; do
  [[ -n "$runtime_ref" ]] || continue
  if [[ "$runtime_ref" = /* ]]; then
    runtime_path="$runtime_ref"
  else
    runtime_path="$(cd "$out_dir" && realpath -m "$runtime_ref")"
  fi
  [[ -e "$runtime_path" ]] || {
    echo "Chrome Fuzz toolchain preflight failed: GN/Ninja compiler-rt input is missing: $runtime_ref ($runtime_path)" >&2
    exit 1
  }
done <"$runtime_refs_file"

printf 'Chrome Fuzz toolchain preflight passed: target=%s host=%s compiler=%s (%s)\n' \
  "$target_arch" "$host_arch" "$compiler_path" "$compiler_format"
