#!/usr/bin/env bash
# rust_ASC v0.1.1 CLI adapter. Never fall back after a Rust failure.
set -euo pipefail
binary="${RUST_ASC_BIN:-/opt/deepsonar/rust-asc/rust_ASC}"
if [[ ! -x "$binary" ]]; then
  echo "rust_ASC executable unavailable: $binary" >&2
  exit 127
fi
# Upstream's no-argument help succeeds; --help incorrectly exits 1.
# Only the exact top-level help invocation uses this equivalent path.
if [[ $# == 0 || ( $# == 1 && ( "$1" == --help || "$1" == -h ) ) ]]; then
  exec "$binary"
fi
if [[ $# == 1 && "$1" == --version ]]; then
  "$binary" >/dev/null
  echo 'rust_ASC v0.1.1 (236dd096669c99eb30f6e1af0b24e668eff55dd5; CLI-only; DeepSonar adapter)'
  exit 0
fi
# Translate the documented Python spelling, preserving argument boundaries,
# option values and tokens after --. The backend validates all other input.
args=()
value=false
literal=false
for arg in "$@"; do
  if $literal || $value; then
    args+=("$arg")
    value=false
    continue
  fi
  case "$arg" in
    --) literal=true ;;
    --threads) arg=--thread; value=true ;;
    --threads=*) arg="--thread=${arg#--threads=}" ;;
    -o|--output|--class|--thread|--prefix) value=true ;;
  esac
  args+=("$arg")
done
# Upstream findrefs can report success for an unreadable/corrupt ZIP. Validate
# the APK container before queries so this cannot masquerade as no matches.
# Help/invalid syntax still goes to the backend; skip option values faithfully.
case "${args[0]}" in
  getclass|getmanifest|findrefs|listclass|export)
    value=false
    for arg in "${args[@]:1}"; do
      if $value; then value=false; continue; fi
      case "$arg" in
        -h|--help) break ;;
        -o|--output|--thread|--class|--prefix) value=true; continue ;;
        --*=*|--debug|--fuzzy-class) continue ;;
        -*) break ;;
      esac
      if ! unzip -tqq -- "$arg" >/dev/null; then
        echo "rust_ASC: unreadable or corrupt APK container: $arg" >&2
        exit 2
      fi
      break
    done
    ;;
esac
exec "$binary" "${args[@]}"
