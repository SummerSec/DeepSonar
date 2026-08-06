#!/usr/bin/env bash
# Resolve content-addressed GHCR src-* tags for skip-if-unchanged builds.
#
# resolve:
#   IMAGE_NAME=ghcr.io/owner/deepsonar-base FINGERPRINT=... SRC_TAG=src-... \
#     ./agent-harness/resolve-image-src-cache.sh resolve
#   → GITHUB_OUTPUT: skip=true|false, digest=sha256:..., src_ref=...
#
# pin:
#   IMAGE_NAME=... FINGERPRINT=... DIGEST=sha256:... SRC_TAG=src-... \
#     ./agent-harness/resolve-image-src-cache.sh pin
#   Tags IMAGE_NAME:src-<fp> at DIGEST (idempotent).
set -euo pipefail

mode="${1:-resolve}"
image_name="${IMAGE_NAME:?IMAGE_NAME required}"
fingerprint="${FINGERPRINT:?FINGERPRINT required}"
src_tag="${SRC_TAG:-src-${fingerprint}}"
src_ref="${image_name}:${src_tag}"

inspect_digest() {
  local ref="$1"
  local digest=""
  # Prefer quiet digest when supported; fall back to text parse.
  if digest="$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>/dev/null)" \
    && [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '%s\n' "$digest"
    return 0
  fi
  if digest="$(docker buildx imagetools inspect "$ref" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*Digest:[[:space:]]*(sha256:[0-9a-f]{64}).*/\1/p' \
    | head -n1)" \
    && [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '%s\n' "$digest"
    return 0
  fi
  return 1
}

write_output() {
  local key="$1" value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
  printf '%s=%s\n' "$key" "$value"
}

case "$mode" in
  resolve)
    write_output src_ref "$src_ref"
    if digest="$(inspect_digest "$src_ref")"; then
      write_output skip true
      write_output digest "$digest"
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        echo "image build unchanged: reuse ${src_ref} @ ${digest}" >> "$GITHUB_STEP_SUMMARY"
      fi
    else
      write_output skip false
      write_output digest ""
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        echo "image build cache miss: will build ${src_ref}" >> "$GITHUB_STEP_SUMMARY"
      fi
    fi
    ;;
  pin)
    digest="${DIGEST:?DIGEST required for pin}"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || {
      echo "DIGEST must be sha256:..." >&2
      exit 1
    }
    source_ref="${image_name}@${digest}"
    # Always (re)point the content tag so version retags can reuse it next release.
    docker buildx imagetools create --prefer-index=false -t "$src_ref" "$source_ref"
    write_output src_ref "$src_ref"
    write_output digest "$digest"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      echo "pinned ${src_ref} -> ${digest}" >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;
  *)
    echo "usage: $0 resolve|pin" >&2
    exit 1
    ;;
esac
