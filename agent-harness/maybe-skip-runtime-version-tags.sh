#!/usr/bin/env bash
# When a runtime-catalog product fingerprint is unchanged *and* the previous
# catalog already has SOURCE_DIGEST, do not invent a new platform-version tag.
# Exit 0 after writing the existing digest; exit 1 to publish.
# A src-cache hit is not enough: if that digest was never cataloged, version
# tags must still be published so inspect can record a real catalog row.
set -euo pipefail
if [[ "${SKIP:-}" != "true" ]]; then
  exit 1
fi
if [[ ! "${SOURCE_DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "maybe-skip-runtime-version-tags: SOURCE_DIGEST must be an immutable sha256 digest" >&2
  exit 2
fi

image_key="${IMAGE_KEY:-}"
if [[ -z "$image_key" && -n "${IMAGE_NAME:-}" ]]; then
  image_key="${IMAGE_NAME##*/}"
fi
if [[ -z "$image_key" ]]; then
  echo "maybe-skip-runtime-version-tags: cannot resolve image key; publishing version tags" >&2
  exit 1
fi

set +e
node agent-harness/reuse-catalog-descriptor.mjs \
  --probe \
  --image-key "$image_key" \
  --digest "$SOURCE_DIGEST" \
  --catalog "${PREVIOUS_REGISTRY:-deploy/runtime-image-registry.json}"
reuse_status=$?
set -e
if [[ "$reuse_status" -eq 0 ]]; then
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "image build unchanged; version kept" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "image build unchanged; version kept" >&2
  fi
  printf 'digest=%s\n' "$SOURCE_DIGEST" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  exit 0
fi
if [[ "$reuse_status" -eq 2 ]]; then
  echo "maybe-skip-runtime-version-tags: ${image_key} previous catalog has no ${SOURCE_DIGEST}; publishing version tags" >&2
  exit 1
fi
exit "$reuse_status"
