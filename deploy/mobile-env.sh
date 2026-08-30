#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：mobile-env.sh --check

移动端专项运行时提供 Android（JADX CLI、apktool、bundletool、apkeep、androguard、官方 ADB、Frida/Objection）、
轻量 .so（binutils / radare2 / LIEF）、
iOS Linux 宿主（idevice_id / ideviceinstaller / plistutil / iproxy）与
OpenHarmony 应用/设备（HAP 静态检查 + 官方 hdc）。
不预装决策扫描器、jadx-gui、MobSF、Burp、mitmproxy、IDA、Ghidra、DevEco、第三方 MCP 或完整 OH SDK。
EOF
}

check_manifest() {
  [[ -s /opt/deepsonar/tool-manifest.json ]]
  jq -e '
    .contract == "deepsonar.runtime.contract/v1" and
    .imageKey == "deepsonar-mobile" and
    .device.android.protocol == "adb" and
    .device.ios.protocol == "usbmuxd" and
    .device.openharmony.protocol == "hdc" and
    (.tools | index("jadx")) and
    (.tools | index("apktool")) and
    (.tools | index("bundletool")) and
    (.tools | index("apkeep")) and
    (.tools | index("androguard")) and
    (.tools | index("readelf")) and
    (.tools | index("r2")) and
    (.tools | index("adb")) and
    (.tools | index("hdc")) and
    (.tools | index("idevice_id")) and
    (.tools | index("frida")) and
    (.tools | index("objection"))
  ' /opt/deepsonar/tool-manifest.json >/dev/null
}

smoke_hdc() {
  local hdc_bin="${HDC_BIN:-hdc}"
  local version verbose
  version="$("$hdc_bin" version 2>&1 || true)"
  verbose="$("$hdc_bin" -v 2>&1 || true)"
  if [[ "${version}${verbose}" != *Ver:* ]]; then
    printf 'Mobile 环境检查失败：hdc version / hdc -v 无有效输出\n%s\n%s\n' "$version" "$verbose" >&2
    return 1
  fi
}

check_tools() {
  local command_name
  for command_name in java jadx apktool bundletool apkeep androguard readelf objdump nm r2 adb hdc idevice_id ideviceinstaller plistutil iproxy frida objection jq unzip; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'Mobile 环境检查失败：缺少命令 %s\n' "$command_name" >&2
      return 1
    }
  done
  java -version >/dev/null 2>&1
  jadx --version >/dev/null
  apktool --version >/dev/null
  bundletool version >/dev/null
  apkeep --help >/dev/null
  androguard --help >/dev/null
  readelf --version >/dev/null
  objdump --version >/dev/null
  r2 -qv >/dev/null
  /opt/deepsonar/bin/mobile-so.sh --check >/dev/null
  adb version >/dev/null
  smoke_hdc
  idevice_id --help >/dev/null 2>&1 || idevice_id -h >/dev/null 2>&1 || true
  plistutil -h >/dev/null 2>&1 || plistutil --help >/dev/null 2>&1 || true
  frida --version >/dev/null
  objection version >/dev/null
  for command_name in semgrep gitleaks shellcheck mobsf jadx-gui burpsuite mitmdump mitmproxy ida64 ghidra analyzeHeadless cutter deveco; do
    if command -v "$command_name" >/dev/null 2>&1; then
      printf 'Mobile 运行时不得预装 %s\n' "$command_name" >&2
      return 1
    fi
  done
  local server
  for server in \
    /opt/deepsonar/frida-server/frida-server-android-arm \
    /opt/deepsonar/frida-server/frida-server-android-arm64 \
    /opt/deepsonar/frida-server/frida-server-android-x86_64
  do
    [[ -x "$server" ]] || {
      printf 'Mobile 环境检查失败：缺少 Frida server %s\n' "$server" >&2
      return 1
    }
  done
  [[ -x /opt/deepsonar/hdc/hdc ]] || {
    printf 'Mobile 环境检查失败：缺少官方 hdc\n' >&2
    return 1
  }
  check_manifest
}

if [[ "${1:-}" == "--check" && $# -eq 1 ]]; then
  check_tools
  printf 'Mobile 环境检查通过：Android / iOS 宿主 / OpenHarmony HAP+hdc 已就绪\n'
  exit 0
fi

usage >&2
exit 2
