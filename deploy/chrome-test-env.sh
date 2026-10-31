#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--check" || $# -ne 1 ]]; then
  echo '用法：chrome-test-env.sh --check' >&2
  exit 2
fi

for command_name in chromium node jq claude; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Chrome Test 环境检查失败：缺少命令 %s\n' "$command_name" >&2
    exit 1
  }
done
chromium --version >/dev/null
NODE_PATH="${NODE_PATH:-/usr/local/lib/node_modules}" node -e 'const p=require("playwright-core"); if (typeof p.chromium?.connectOverCDP !== "function") process.exit(1)'
jq -e '.contract == "deepsonar.runtime.contract/v1" and .imageKey == "deepsonar-chrome-test" and .browser.protocol == "cdp"' /opt/deepsonar/tool-manifest.json >/dev/null
printf 'Chrome Test 环境检查通过：Chromium headless + Playwright CDP 已就绪\n'
