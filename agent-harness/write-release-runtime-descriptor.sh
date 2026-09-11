#!/usr/bin/env bash
# Write a release descriptor. Unchanged fingerprints reuse the previous catalog
# version record when that digest is already present. If SKIP=true but the
# src-cache digest was never cataloged, inspect published channels instead of
# failing the job. Evidence still comes from record-runtime-image-digest.mjs.
set -euo pipefail
output="${1:-}"
[[ -n "$output" ]] || { echo "usage: write-release-runtime-descriptor.sh <output-file>" >&2; exit 2; }

record_descriptor() {
  exec node agent-harness/record-runtime-image-digest.mjs "$output"
}

note() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "$1" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "$1" >&2
  fi
}

if [[ "${SKIP:-}" != "true" ]]; then
  record_descriptor
fi

set +e
node agent-harness/reuse-catalog-descriptor.mjs \
  --image-key "${IMAGE_KEY:?}" \
  --digest "${DIGEST:?}" \
  --catalog "${PREVIOUS_REGISTRY:-deploy/runtime-image-registry.json}" \
  --out "$output"
reuse_status=$?
set -e
if [[ "$reuse_status" -eq 0 ]]; then
  note "image build unchanged; version kept"
  exit 0
fi
if [[ "$reuse_status" -ne 2 ]]; then
  exit "$reuse_status"
fi

note "image build unchanged; previous catalog has no row for ${DIGEST}; inspecting published channels"
record_descriptor
