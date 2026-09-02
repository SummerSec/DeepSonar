#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  echo '用法：clickhouse-fuzz-env.sh --check' >&2
  exit 2
fi

fail_check() {
  printf 'ClickHouse Fuzz 环境检查失败：%s\n' "$1" >&2
  exit 1
}

for command_name in clang clang++ lld llvm-symbolizer afl-fuzz afl-clang-fast clickhouse clickhouse-local objdump readelf jq node claude; do
  command -v "$command_name" >/dev/null 2>&1 || fail_check "缺少命令 $command_name"
done

clang --version >/dev/null || fail_check "clang --version 执行失败"
resource_dir=""
if ! resource_dir="$(clang -print-resource-dir 2>&1)" || [[ -z "$resource_dir" ]]; then
  fail_check "clang resource dir 检查失败：${resource_dir:-无输出}"
fi

clickhouse_path="$(command -v clickhouse)"
clickhouse_file=""
if ! clickhouse_file="$(file -Lb "$clickhouse_path" 2>&1)"; then
  fail_check "clickhouse 文件格式检查执行失败：${clickhouse_file:-无输出}"
fi
[[ "$clickhouse_file" =~ ELF.*(x86-64|ARM\ aarch64) ]] || fail_check "clickhouse ELF 架构不符合预期：$clickhouse_file"

version=""
if ! version="$(clickhouse --version 2>&1)"; then
  fail_check "clickhouse --version 执行失败：${version:-无输出}"
fi
[[ "$version" == *26.3.28.5* ]] || fail_check "clickhouse 不是钉死的官方 26.3.28.5：${version:-无输出}"

if ! jq -e '.contract == "deepsonar.runtime.contract/v1" and .imageKey == "deepsonar-clickhouse-fuzz" and .fuzz.target == "clickhouse-local" and .fuzz.actual == true and .clickhouse.official == true' /opt/deepsonar/tool-manifest.json >/dev/null 2>&1; then
  manifest_summary="$(jq -c '{contract, imageKey, fuzz, clickhouse}' /opt/deepsonar/tool-manifest.json 2>&1 || true)"
  fail_check "tool manifest contract 不匹配：${manifest_summary:-无法读取 /opt/deepsonar/tool-manifest.json}"
fi
printf 'ClickHouse Fuzz 环境检查通过：官方 clickhouse-local、Clang/LLVM、compiler-rt/libFuzzer 与 AFL++ 已就绪\n'
