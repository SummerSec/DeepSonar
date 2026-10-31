#!/usr/bin/env bash
set -euo pipefail

source_ref="${1:?source image digest reference is required}"
platforms="${2:?comma-separated platforms are required}"
image_name="${source_ref%@*}"
raw_manifest="$(docker buildx imagetools inspect --raw "$source_ref")"

IFS=',' read -r -a requested_platforms <<< "$platforms"
for platform in "${requested_platforms[@]}"; do
  IFS='/' read -r os architecture variant extra <<< "$platform"
  if [[ -z "$os" || -z "$architecture" || -n "${extra:-}" ]]; then
    echo "invalid target platform: $platform" >&2
    exit 1
  fi

  mapfile -t digests < <(
    jq -r --arg os "$os" --arg architecture "$architecture" --arg variant "${variant:-}" '
      .manifests[]?
      | select((.artifactType? // "") == "")
      | select((.annotations?["vnd.docker.reference.type"]? // "") != "attestation-manifest")
      | select(.platform.os? == $os)
      | select(.platform.architecture? == $architecture)
      | select((.platform.variant? // "") == $variant)
      | .digest
      | select(test("^sha256:[0-9a-f]{64}$"))
    ' <<< "$raw_manifest" | sort -u
  )

  if [[ ${#digests[@]} -ne 1 ]]; then
    echo "expected exactly one runnable descriptor for $platform, found ${#digests[@]}" >&2
    exit 1
  fi
  printf '%s@%s\n' "$image_name" "${digests[0]}"
done
