#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  echo '用法：chrome-fuzz-env.sh --check' >&2
  exit 2
fi

for command_name in clang clang++ lld llvm-symbolizer afl-fuzz afl-clang-fast d8 v8_simple_json_fuzzer objdump readelf jq node claude; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Chrome Fuzz 环境检查失败：缺少命令 %s\n' "$command_name" >&2
    exit 1
  }
done
clang --version >/dev/null
clang -print-resource-dir >/dev/null
afl-fuzz -V >/dev/null
file "$(command -v d8)" | grep -E 'ELF .* (x86-64|ARM aarch64)' >/dev/null
d8 --version >/dev/null
jq -e '.contract == "deepsonar.runtime.contract/v1" and .imageKey == "deepsonar-chrome-fuzz" and .fuzz.target == "d8" and .fuzz.libfuzzer_target == "v8_simple_json_fuzzer" and .fuzz.actual == true' /opt/deepsonar/tool-manifest.json >/dev/null
printf 'Chrome Fuzz 环境检查通过：真实 V8 d8、Clang/LLVM、compiler-rt/libFuzzer 与 AFL++ 已就绪\n'
