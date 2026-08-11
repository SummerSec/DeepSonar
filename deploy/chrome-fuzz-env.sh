#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  echo '用法：chrome-fuzz-env.sh --check' >&2
  exit 2
fi

fail_check() {
  printf 'Chrome Fuzz 环境检查失败：%s\n' "$1" >&2
  exit 1
}

for command_name in clang clang++ lld llvm-symbolizer afl-fuzz afl-clang-fast d8 v8_json_libfuzzer objdump readelf jq node claude; do
  command -v "$command_name" >/dev/null 2>&1 || fail_check "缺少命令 $command_name"
done

clang_version=""
if ! clang_version="$(clang --version 2>&1)"; then
  fail_check "clang --version 执行失败：${clang_version:-无输出}"
fi
resource_dir=""
if ! resource_dir="$(clang -print-resource-dir 2>&1)" || [[ -z "$resource_dir" ]]; then
  fail_check "clang resource dir 检查失败：${resource_dir:-无输出}"
fi

d8_path="$(command -v d8)"
d8_file=""
if ! d8_file="$(file -Lb "$d8_path" 2>&1)"; then
  fail_check "d8 文件格式检查执行失败：${d8_file:-无输出}"
fi
[[ "$d8_file" =~ ELF.*(x86-64|ARM\ aarch64) ]] || fail_check "d8 ELF 架构不符合预期：$d8_file"
d8_version=""
if ! d8_version="$(d8 --version 2>&1)"; then
  fail_check "d8 --version 执行失败：${d8_version:-无输出}"
fi
[[ "$d8_version" == V8* ]] || fail_check "d8 版本输出不是 V8：${d8_version:-无输出}"

if ! jq -e '.contract == "deepsonar.runtime.contract/v1" and .imageKey == "deepsonar-chrome-fuzz" and .fuzz.target == "d8" and .fuzz.libfuzzer_target == "v8_json_libfuzzer" and .fuzz.actual == true' /opt/deepsonar/tool-manifest.json >/dev/null 2>&1; then
  manifest_summary="$(jq -c '{contract, imageKey, fuzz: {target: .fuzz.target, libfuzzer_target: .fuzz.libfuzzer_target, actual: .fuzz.actual}}' /opt/deepsonar/tool-manifest.json 2>&1 || true)"
  fail_check "tool manifest contract 不匹配：${manifest_summary:-无法读取 /opt/deepsonar/tool-manifest.json}"
fi
printf 'Chrome Fuzz 环境检查通过：真实 V8 d8、Clang/LLVM、compiler-rt/libFuzzer 与 AFL++ 已就绪\n'
