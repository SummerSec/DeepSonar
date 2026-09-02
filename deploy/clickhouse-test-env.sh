#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  echo '用法：clickhouse-test-env.sh --check' >&2
  exit 2
fi

fail_check() {
  printf 'ClickHouse Test 环境检查失败：%s\n' "$1" >&2
  exit 1
}

for command_name in git clickhouse clickhouse-client clickhouse-local clickhouse-server jq node claude; do
  command -v "$command_name" >/dev/null 2>&1 || fail_check "缺少命令 $command_name"
done

version=""
if ! version="$(clickhouse --version 2>&1)"; then
  fail_check "clickhouse --version 执行失败：${version:-无输出}"
fi
[[ "$version" == *26.3.28.5* ]] || fail_check "clickhouse 版本不是钉死的 26.3.28.5：${version:-无输出}"

if ! jq -e '.contract == "deepsonar.runtime.contract/v1" and .imageKey == "deepsonar-clickhouse-test" and .clickhouse.binary == "/opt/deepsonar/bin/clickhouse" and .clickhouse.official == true' /opt/deepsonar/tool-manifest.json >/dev/null 2>&1; then
  fail_check "tool manifest contract 不匹配"
fi
printf 'ClickHouse Test 环境检查通过：官方 clickhouse-common-static %s\n' "$version"
