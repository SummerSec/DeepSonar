#!/usr/bin/env bash
# #893 P3: land the bundled catalog on the default branch through the required check.
# Idempotent: when the default branch already carries this release's catalog the script
# exits early, so a resumed run never creates an empty pull request.
set -euo pipefail

payload_dir="${1:-frozen-release}"
: "${VERSION:?VERSION is required}"
: "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

registry_file="deploy/runtime-image-registry.json"
env_file="deploy/.env.example"
cp "$payload_dir/deploy/runtime-image-registry.json" "$registry_file"
[[ -f "$registry_file" ]]
[[ -f "$env_file" ]]
[[ "$VERSION" =~ ^[0-9][^[:space:]]*$ ]]
node agent-harness/generate-runtime-image-registry.mjs --check "$registry_file"

# Preserve generated files before checking out the default branch.
tmp_registry="$(mktemp)"
tmp_env="$(mktemp)"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin "$DEFAULT_BRANCH"
git show "origin/${DEFAULT_BRANCH}:$env_file" > "$tmp_env"
node agent-harness/check-platform-release.mjs --write-env "$registry_file" "$tmp_env"
git checkout -f -B "bot/sync-runtime-registry-v${VERSION}" "origin/${DEFAULT_BRANCH}"
cp "$registry_file" "$tmp_registry"
cp "$tmp_env" "$env_file"
rm -f "$tmp_env"
git add -- "$registry_file" "$env_file"
if git diff --cached --quiet -- "$registry_file" "$env_file"; then
  echo "默认分支上的 $registry_file 和 $env_file 已是本次发布内容，跳过回写"
  exit 0
fi
git commit -m "chore(release): sync runtime-image-registry.json and platform digests for v${VERSION}"
cp "$tmp_registry" "$registry_file"
rm -f "$tmp_registry"
WRITEBACK_BRANCH="bot/sync-runtime-registry-v${VERSION}" WRITEBACK_SHA="$(git rev-parse HEAD)" \
  node agent-harness/release-writeback.mjs | tee /tmp/writeback.json
echo "已将 $registry_file 和 $env_file 经 ci-summary 校验后回写到 origin/${DEFAULT_BRANCH}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
