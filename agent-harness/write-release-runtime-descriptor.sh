#!/usr/bin/env bash
# Write a release descriptor. Unchanged fingerprints reuse the previous catalog
# version record; changed products still inspect newly published tags.
set -euo pipefail
output="${1:-}"
[[ -n "$output" ]] || { echo "usage: write-release-runtime-descriptor.sh <output-file>" >&2; exit 2; }
if [[ "${SKIP:-}" == "true" ]]; then
  echo "image build unchanged; version kept" >> "${GITHUB_STEP_SUMMARY:-/dev/stderr}"
  # src-* is the build-push/provenance index; catalog digest is the published
  # imagetools index. Fingerprint skip already proved content is unchanged.
  exec node agent-harness/reuse-catalog-descriptor.mjs \
    --image-key "${IMAGE_KEY:?}" \
    --catalog "${PREVIOUS_REGISTRY:-deploy/runtime-image-registry.json}" \
    --out "$output"
fi
exec node agent-harness/record-runtime-image-digest.mjs "$output"
