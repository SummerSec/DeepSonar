#!/usr/bin/env bash
# #893 P3: land the bundled catalog on the default branch through the required check.
#
# Ordering is load-bearing. `git checkout -f -B … origin/<branch>` restores every
# tracked file to that branch, so BOTH generated files must be captured into temp files
# *before* the checkout. v0.6.12 proved the failure mode: the capture ran after the
# checkout, stored main's previous catalog, and the commit carried only
# deploy/.env.example while deploy/runtime-image-registry.json stayed one release
# behind — with .env.example already advertising the new version (#899).
set -euo pipefail

payload_dir="${1:-frozen-release}"
: "${VERSION:?VERSION is required}"
: "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

registry_file="deploy/runtime-image-registry.json"
env_file="deploy/.env.example"

# 1. Put this release's frozen catalog into the worktree and validate its bytes.
cp "$payload_dir/deploy/runtime-image-registry.json" "$registry_file"
[[ -f "$registry_file" ]]
[[ -f "$env_file" ]]
[[ "$VERSION" =~ ^[0-9][^[:space:]]*$ ]]
node agent-harness/generate-runtime-image-registry.mjs --check "$registry_file"

# 2. Capture both generated files BEFORE any branch switch, then rewrite the deployment
#    example from the captured catalog. Nothing below may move these temps later.
tmp_registry="$(mktemp)"
tmp_env="$(mktemp)"
trap 'rm -f "$tmp_registry" "$tmp_env"' EXIT
cp "$registry_file" "$tmp_registry"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin "$DEFAULT_BRANCH"
git show "origin/${DEFAULT_BRANCH}:$env_file" > "$tmp_env"
node agent-harness/check-platform-release.mjs --write-env "$tmp_registry" "$tmp_env"

# 3. Switch to the bot branch and lay the captured files on top of it.
git checkout -f -B "bot/sync-runtime-registry-v${VERSION}" "origin/${DEFAULT_BRANCH}"
cp "$tmp_registry" "$registry_file"
cp "$tmp_env" "$env_file"

# 4. Refuse anything but this release's bytes. A capture bug must fail here instead of
#    producing a half-updated commit or a silent "already up to date" exit.
VERSION="$VERSION" REGISTRY_FILE="$registry_file" ENV_FILE="$env_file" node -e '
  const {readFileSync} = require("node:fs");
  const version = process.env.VERSION;
  const catalog = JSON.parse(readFileSync(process.env.REGISTRY_FILE, "utf8"));
  if (catalog.platform_version !== version) {
    throw new Error(`writeback captured platform_version=${catalog.platform_version}, expected ${version} (#899)`);
  }
  const declared = readFileSync(process.env.ENV_FILE, "utf8").match(/^DEEPSONAR_VERSION=(.*)$/m)?.[1];
  if (declared !== version) throw new Error(`writeback captured DEEPSONAR_VERSION=${declared}, expected ${version}`);
'

git add -- "$registry_file" "$env_file"
# Only skip when BOTH files on the default branch already carry this release; either one
# being stale means the writeback still has work to do.
if git diff --cached --quiet -- "$registry_file" "$env_file"; then
  echo "默认分支上的 $registry_file 和 $env_file 已是 v${VERSION} 的发布内容，跳过回写"
  exit 0
fi
git commit -m "chore(release): sync runtime-image-registry.json and platform digests for v${VERSION}"
WRITEBACK_BRANCH="bot/sync-runtime-registry-v${VERSION}" WRITEBACK_SHA="$(git rev-parse HEAD)" \
  node agent-harness/release-writeback.mjs | tee /tmp/writeback.json
echo "已将 $registry_file 和 $env_file 经 ci-summary 校验后回写到 origin/${DEFAULT_BRANCH}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"