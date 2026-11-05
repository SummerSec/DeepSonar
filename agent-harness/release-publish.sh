#!/usr/bin/env bash
# #893 P4: publish the frozen payload as a Release. Independent from the bundled
# writeback so a writeback failure can never withhold the Release.
set -euo pipefail

payload_dir="${1:-frozen-release}"
signature_dir="${2:-signature-evidence}"
: "${VERSION:?VERSION is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

[[ -f "$payload_dir/release-body.md" ]]
node agent-harness/platform-signature-publication.mjs gate "$payload_dir" "$signature_dir"

# Idempotent: an existing Release is left untouched rather than overwritten.
# gh release view cannot distinguish missing from authentication/network errors.
state="$(node agent-harness/release-publication-state.mjs "$payload_dir" "$signature_dir")"
if [[ "$state" == existing ]]; then
  echo "Release v${VERSION} already exists; leaving it untouched"
  exit 0
fi

gh release create "v${VERSION}" --repo "$GITHUB_REPOSITORY" --verify-tag --generate-notes \
  --notes-file "$payload_dir/release-body.md" \
  "$payload_dir/deepsonar-reverse-evidence-${VERSION}.tar.gz" \
  "$payload_dir/deepsonar-management-skill-${VERSION}.tar.gz" \
  "$payload_dir/deploy/runtime-image-registry.json" \
  "$payload_dir/runtime-image-registry-v2.json" \
  "$signature_dir/platform-signature-evidence.json"
echo "Published Release v${VERSION}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
