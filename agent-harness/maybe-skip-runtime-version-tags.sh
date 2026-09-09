#!/usr/bin/env bash
# When a runtime-catalog product fingerprint is unchanged, do not invent a new
# platform-version tag. Exit 0 after writing the existing digest; exit 1 to publish.
set -euo pipefail
if [[ "${SKIP:-}" != "true" ]]; then
  exit 1
fi
if [[ ! "${SOURCE_DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "maybe-skip-runtime-version-tags: SOURCE_DIGEST must be an immutable sha256 digest" >&2
  exit 2
fi
echo "image build unchanged; version kept" >> "${GITHUB_STEP_SUMMARY:-/dev/stderr}"
printf 'digest=%s\n' "$SOURCE_DIGEST" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
exit 0
