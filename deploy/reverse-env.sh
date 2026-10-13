#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：reverse-env.sh --check

deepsonar-reverse 提供钉死的 REA CLI + Ghidra 12.1.4 + 完整 JDK 21，用于 ELF/.so/PE 深度静态分析。
CLI-only：不注册 MCP、不安装 Hopper/IDA、不启动常驻 REA 服务。不改变全局默认镜像。
USAGE
}

check_manifest() {
  [[ -s /opt/deepsonar/tool-manifest.json ]]
  jq -e '
    .contract == "deepsonar.runtime.contract/v1" and
    .imageKey == "deepsonar-reverse" and
    .toolset == "reverse" and
    .project_opt_in == true and
    (.tools | index("rea")) and
    (.tools | index("analyzeHeadless")) and
    (.tools | index("java")) and
    .ghidra.install_dir == "/opt/deepsonar/ghidra" and
    .ghidra.version == "12.1.4" and
    .rea.version == "6.4.0"
  ' /opt/deepsonar/tool-manifest.json >/dev/null
}

check_tools() {
  local command_name
  for command_name in java javac rea rea-agents analyzeHeadless jq node ps; do
    command -v "$command_name" >/dev/null 2>&1 || {
      printf 'reverse 环境检查失败：缺少命令 %s\n' "$command_name" >&2
      return 1
    }
  done

  [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]] || {
    printf 'reverse 环境检查失败：JAVA_HOME 无效\n' >&2
    return 1
  }
  [[ -n "${GHIDRA_INSTALL_DIR:-}" && -x "${GHIDRA_INSTALL_DIR}/support/analyzeHeadless" ]] || {
    printf 'reverse 环境检查失败：GHIDRA_INSTALL_DIR 无效\n' >&2
    return 1
  }

  local java_ver node_ver rea_ver
  java_ver="$(java -version 2>&1 | head -n1 || true)"
  [[ "$java_ver" == *'"21.'* || "$java_ver" == *' version "21'* ]] || {
    printf 'reverse 环境检查失败：需要完整 JDK 21，实际：%s\n' "$java_ver" >&2
    return 1
  }

  node_ver="$(node -p "process.versions.node")"
  node /opt/deepsonar/bin/reverse-toolchain-check.mjs --node-version "$node_ver" || {
    printf 'reverse 环境检查失败：Node 不满足 ^22.19.0 || ^24.11.0 || >=26.0.0，实际：%s\n' "$node_ver" >&2
    return 1
  }

  node -e 'const p=require("/opt/deepsonar/rea/node_modules/rea-agents/package.json"); if (p.version !== "6.4.0") { console.error(p.version); process.exit(1); }' || {
    printf 'reverse 环境检查失败：rea-agents 版本不是 6.4.0\n' >&2
    return 1
  }

  # REA prepares procps-backed ownership before spawning the headless JVM.
  # Check its pinned implementation, including ps output parsing and our own PID.
  node --input-type=module -e 'import { prepareProcessOwnershipInspection } from "/opt/deepsonar/rea/node_modules/rea-agents/dist/process/ProcessOwnershipObservation.js"; await prepareProcessOwnershipInspection();' || {
    printf 'reverse 环境检查失败：REA 进程所有权检查需要兼容 procps 的 ps\n' >&2
    return 1
  }

  javac -version 2>&1 | grep -E '^javac 21([.]|$)' >/dev/null
  java -XshowSettings:properties -version 2>&1 | grep -E 'sun.arch.data.model = 64' >/dev/null
  grep -qx 'application.version=12.1.4' "$GHIDRA_INSTALL_DIR/Ghidra/application.properties"
  local arch platform decomp_bin
  case "$(node -p 'process.arch'):$(uname -m)" in
    x64:x86_64) arch=amd64; platform=linux_x86_64 ;;
    arm64:aarch64|arm64:arm64) arch=arm64; platform=linux_arm_64 ;;
    *) printf 'reverse 环境检查失败：运行架构不匹配\n' >&2; return 1 ;;
  esac
  decomp_bin="$GHIDRA_INSTALL_DIR/Ghidra/Features/Decompiler/os/$platform/decompile"
  [[ -x "$decomp_bin" ]]
  node /opt/deepsonar/bin/reverse-toolchain-check.mjs --elf "$decomp_bin" "$arch"
  node - "$decomp_bin" "$arch" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const [binary, arch] = process.argv.slice(2);
const provenance = JSON.parse(fs.readFileSync(`${binary}.provenance.json`));
assert.equal(provenance.architecture, arch);
assert.equal(provenance.ghidra_version, '12.1.4');
assert.equal(provenance.public_zip_sha256, 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db');
assert.equal(provenance.sha256, crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'));
const p = require('/opt/deepsonar/rea/node_modules/rea-agents/package.json');
const downloaded = require('/opt/deepsonar/rea/download-integrity.json');
const lock = require('/opt/deepsonar/rea/package-lock.json');
const manifest = require('/opt/deepsonar/tool-manifest.json');
assert.equal(p.engines.node, '^22.19.0 || ^24.11.0 || >=26.0.0');
assert.equal(downloaded.artifact_verified, true);
assert.equal(downloaded.integrity, manifest.rea.integrity);
assert.equal(lock.packages['node_modules/rea-agents'].integrity, manifest.rea.integrity);
assert.equal(manifest.ghidra.native_decompiler_arch, arch);
NODE

  # Forbidden surfaces in this image
  for command_name in hopper ida64 ida mcp-server ghidraRun; do
    if command -v "$command_name" >/dev/null 2>&1; then
      printf 'reverse 运行时不得预装/暴露 %s\n' "$command_name" >&2
      return 1
    fi
  done

  check_manifest
}

main() {
  case "${1:-}" in
    --check) check_tools; printf 'reverse-env check ok\n' ;;
    -h|--help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
