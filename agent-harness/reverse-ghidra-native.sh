#!/usr/bin/env bash
# Only use source from the SHA-256-verified Ghidra 12.1.4 PUBLIC zip.
# Upstream 12.1.4 PUBLIC ships Linux x86_64, but no Linux arm64 native decompiler.
# The bundled standalone Makefile defaults non-x86_64 Linux to -m32; override it.
set -euo pipefail
[[ $# == 2 ]] || { echo 'usage: reverse-ghidra-native.sh GHIDRA_ROOT amd64|arm64' >&2; exit 2; }
root=$(realpath "$1")
arch=$2
case "$arch:$(uname -m)" in
  amd64:x86_64) platform=linux_x86_64 ;;
  arm64:aarch64|arm64:arm64) platform=linux_arm_64 ;;
  *) echo 'Ghidra native build architecture differs from the builder; refusing cross/emulated claim' >&2; exit 1 ;;
esac
node "$(dirname "$0")/reverse-toolchain-check.mjs" --node-version "$(node -p 'process.versions.node')"
grep -qx 'application.version=12.1.4' "$root/Ghidra/application.properties"
source_dir="$root/Ghidra/Features/Decompiler/src/decompile/cpp"
binary="$root/Ghidra/Features/Decompiler/os/$platform/decompile"
method=public-zip-prebuilt
if [[ ! -x "$binary" ]]; then
  [[ "$arch" == arm64 ]] || { echo 'pinned PUBLIC zip lacks amd64 native decompiler' >&2; exit 1; }
  [[ -f "$source_dir/Makefile" && -f "$source_dir/ghidra_process.cc" ]] || exit 1
  # No Gradle wrapper, unpinned downloads, regenerated parser or cross compiler.
  # SOURCE_DATE_EPOCH and prefix maps make the invocation reproducible on the pinned builder.
  export SOURCE_DATE_EPOCH=1790007180 LC_ALL=C TZ=UTC
  make -C "$source_dir" -j2 ghidra_opt \
    ARCH_TYPE= OSDIR=linux_arm_64 CXX='g++ -std=c++11' \
    OPT_CXXFLAGS="-O2 -Wall -Wno-sign-compare -ffile-prefix-map=$root=/ghidra -fdebug-prefix-map=$root=/ghidra" \
    ADDITIONAL_FLAGS='-Wl,--build-id=none'
  install -D -m 0755 "$source_dir/ghidra_opt" "$binary"
  # Build objects must not enter the runtime image.
  rm -rf "$source_dir/ghi_opt" "$source_dir/ghidra_opt"
  method=public-zip-bundled-source-make-ghidra_opt
fi
node "$(dirname "$0")/reverse-toolchain-check.mjs" --elf "$binary" "$arch"
node --input-type=module - "$binary" "$arch" "$method" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [binary, arch, method] = process.argv.slice(2);
const provenance = {
  schema: 'deepsonar.reverse.native-decompiler/v1', architecture: arch, method,
  ghidra_version: '12.1.4', public_zip_sha256: 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db',
  sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  compiler: method.includes('source') ? execFileSync('g++', ['--version'], {encoding:'utf8'}).split('\n')[0] : null,
  make_target: method.includes('source') ? 'ghidra_opt ARCH_TYPE= OSDIR=linux_arm_64 CXX=g++ -std=c++11' : null,
};
writeFileSync(`${binary}.provenance.json`, JSON.stringify(provenance, null, 2)+'\n');
NODE
