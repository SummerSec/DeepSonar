#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：mobile-env.sh --check

移动端专项运行时提供 Android（JADX CLI、apktool、bundletool、apkeep、androguard、rust_ASC（默认 ASC，droidasc 兼容入口；Python ASC 仅经 droidasc-python 显式回退）、ApkCheckPack、官方 ADB、Frida/Objection）、
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
    (.tools | index("rust_ASC")) and
    (.tools | index("droidasc")) and
    (.tools | index("droidasc-python")) and
    (.tools | index("apkcheckpack")) and
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

buildinfo_value() {
  local file="$1" key="$2" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$file"
  return 1
}

# rust_ASC 上游的 --help 经 clap 写 stderr 且退出码为 1，因此这里只接受 0/1 并要求帮助文本完整；
# 126/127/信号（含 panic=abort）等启动失败仍然失败，不用无条件忽略错误掩盖。
smoke_rust_asc() {
  local rust_asc_home="${RUST_ASC_HOME:-/opt/deepsonar/rust-asc}"
  local rust_asc_bin="${RUST_ASC_BIN:-${rust_asc_home}/rust_ASC}"
  local buildinfo="${RUST_ASC_BUILDINFO:-${rust_asc_home}/BUILDINFO}"
  local output status expected_sha actual_sha subcommand
  [[ -x "$rust_asc_bin" && -s "$buildinfo" ]] || {
    printf 'Mobile 环境检查失败：缺少 rust_ASC 二进制或构建记录\n' >&2
    return 1
  }
  status=0
  output="$("$rust_asc_bin" --help 2>&1)" || status=$?
  if [[ "$status" -ne 0 && "$status" -ne 1 ]]; then
    printf 'Mobile 环境检查失败：rust_ASC --help 退出码 %s\n%s\n' "$status" "$output" >&2
    return 1
  fi
  for subcommand in getclass listclass getmanifest findrefs; do
    if [[ "$output" != *"$subcommand"* || "$output" != *"Usage: rust_ASC"* ]]; then
      printf 'Mobile 环境检查失败：rust_ASC --help 缺少 %s\n%s\n' "$subcommand" "$output" >&2
      return 1
    fi
  done
  status=0
  output="$("$rust_asc_bin" mcp 2>&1)" || status=$?
  if [[ "$status" -eq 0 || "$output" != *"unrecognized subcommand 'mcp'"* ]]; then
    printf 'Mobile 环境检查失败：rust_ASC 必须是关闭 MCP feature 的 CLI-only 构建\n%s\n' "$output" >&2
    return 1
  fi
  [[ "$(buildinfo_value "$buildinfo" implementation)" == "rust_ASC" ]] || {
    printf 'Mobile 环境检查失败：rust_ASC 构建记录 implementation 不匹配\n' >&2
    return 1
  }
  [[ "$(buildinfo_value "$buildinfo" commit)" =~ ^[0-9a-f]{40}$ && "$(buildinfo_value "$buildinfo" radguard_commit)" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'Mobile 环境检查失败：rust_ASC 构建记录缺少源码/子模块修订\n' >&2
    return 1
  }
  [[ "$(buildinfo_value "$buildinfo" cargo_features)" == "--locked --no-default-features" ]] || {
    printf 'Mobile 环境检查失败：rust_ASC 必须以 --locked --no-default-features 构建\n' >&2
    return 1
  }
  expected_sha="$(buildinfo_value "$buildinfo" binary_sha256 || true)"
  actual_sha="$(sha256sum "$rust_asc_bin" | cut -d' ' -f1)"
  if [[ -z "$expected_sha" || "$expected_sha" != "$actual_sha" ]]; then
    printf 'Mobile 环境检查失败：rust_ASC 二进制 SHA256 与构建记录不一致（%s != %s）\n' "$actual_sha" "$expected_sha" >&2
    return 1
  fi
}

smoke_droidasc_entries() {
  local output impl_line python_info python_version installed_version
  output="$(droidasc --help 2>/dev/null)"
  [[ "$output" == *getclass* && "$output" == *findrefs* && "$output" == *"Usage: rust_ASC"* ]] || {
    printf 'Mobile 环境检查失败：droidasc 默认入口必须运行 rust_ASC\n%s\n' "$output" >&2
    return 1
  }
  impl_line="$(droidasc --impl-info)"
  [[ "$impl_line" == *"implementation=rust_ASC"* ]] || {
    printf 'Mobile 环境检查失败：droidasc --impl-info 未标识 rust_ASC\n%s\n' "$impl_line" >&2
    return 1
  }
  output="$(droidasc-python --help 2>/dev/null)"
  [[ "$output" == *getclass* && "$output" == *findrefs* && "$output" == *"usage: droidasc"* ]] || {
    printf 'Mobile 环境检查失败：droidasc-python 显式回退入口不可用\n%s\n' "$output" >&2
    return 1
  }
  python_info="${DROIDASC_PYTHON_BUILDINFO:-/opt/deepsonar/droidasc-python/BUILDINFO}"
  python_version="$(buildinfo_value "$python_info" version || true)"
  installed_version="$(/opt/deepsonar/mobile-venv/bin/python -c 'import importlib.metadata as m; print(m.version("droidasc"))')"
  if [[ -z "$python_version" || "$python_version" != "$installed_version" ]]; then
    printf 'Mobile 环境检查失败：droidasc-python 记录版本 %s 与已安装 %s 不一致\n' "$python_version" "$installed_version" >&2
    return 1
  fi
}

check_tools() {
  local command_name
  for command_name in java jadx apktool bundletool apkeep androguard rust_ASC droidasc droidasc-python apkcheckpack readelf objdump nm r2 adb hdc idevice_id ideviceinstaller plistutil iproxy frida objection jq unzip; do
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
  smoke_rust_asc
  smoke_droidasc_entries
  apkcheckpack -h >/dev/null
  readelf --version >/dev/null
  objdump --version >/dev/null
  r2 -qv >/dev/null
  /opt/deepsonar/bin/mobile-so.sh --check >/dev/null
  adb version >/dev/null
  smoke_hdc
  plistutil -h >/dev/null 2>&1 || plistutil --help >/dev/null 2>&1
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
