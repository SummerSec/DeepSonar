#!/usr/bin/env bash
# Read-only Actions collection. Artifact JSON never establishes its own authority.
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${INPUT_JSON:?INPUT_JSON is required}"
: "${OUT_DIR:?OUT_DIR is required}"
: "${TIMING_HISTORY:?TIMING_HISTORY is required}"
: "${TRUST_JSON:?TRUST_JSON is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${GITHUB_WORKFLOW_SHA:?GITHUB_WORKFLOW_SHA is required}"

mkdir -p "$OUT_DIR" "$TIMING_HISTORY" "$(dirname "$INPUT_JSON")"
printf '[]\n' > "$INPUT_JSON"
context="$(mktemp -d)"
gh api "repos/$GH_REPO" > "$context/repository.json"
gh api "repos/$GH_REPO/actions/workflows/runtime-build-timing.yml" > "$context/workflow.json"
gh api "repos/$GH_REPO/actions/runs/$GITHUB_RUN_ID" > "$context/current.json"
default_branch="$(jq -er '.default_branch' "$context/repository.json")"
collector_sha="$(git rev-parse HEAD)"
# Checkout and workflow are pinned to the same immutable default-branch revision.
[[ "$collector_sha" == "$GITHUB_WORKFLOW_SHA" ]]
[[ "${GITHUB_WORKFLOW_REF:-}" == "$GH_REPO/.github/workflows/runtime-build-timing.yml@refs/heads/$default_branch" ]]
jq -e --arg sha "$collector_sha" --argjson attempt "$GITHUB_RUN_ATTEMPT" \
  '.head_sha == $sha and .run_attempt == $attempt' "$context/current.json" > /dev/null
jq -n --arg repository "$GH_REPO" --arg branch "$default_branch" \
  --slurpfile workflow "$context/workflow.json" --argjson current "$GITHUB_RUN_ID" \
  '{policy: {repository: $repository, default_branch: $branch, workflow_id: $workflow[0].id,
    current_run_id: $current}, collectors: []}' > "$TRUST_JSON"
jq '. + {revision_is_ancestor: true}' "$context/current.json" > "$context/current-verified.json"
node agent-harness/collect-runtime-timing.mjs --validate-collector "$context/current-verified.json" --trust "$TRUST_JSON"
jq --slurpfile current "$context/current-verified.json" '.collectors += $current' "$TRUST_JSON" > "$context/trust.next"
cp "$context/trust.next" "$TRUST_JSON"

# Observe source runs from the API, not from any PR-supplied evidence fields.
if [[ -n "${RUN_IDS:-}" ]]; then
  ids="${RUN_IDS//,/ }"
else
  ids="$(gh run list --repo "$GH_REPO" --workflow "${SOURCE_WORKFLOW:-ci.yml}" \
    --status completed --limit "${RECENT_LIMIT:-20}" --json databaseId -q '.[].databaseId')"
fi
for id in $ids; do
  if [[ ! "$id" =~ ^[0-9]+$ ]]; then
    echo "runtime-timing: skip invalid run id: $id" >&2
    continue
  fi
  entry="$(mktemp -d)"
  if ! gh api "repos/$GH_REPO/actions/runs/$id" > "$entry/run.json"; then
    echo "runtime-timing: cannot read run $id" >&2
    continue
  fi
  if ! gh api --paginate "repos/$GH_REPO/actions/runs/$id/jobs?per_page=100" \
      | jq -s '{jobs: [.[].jobs[]]}' > "$entry/jobs.json"; then
    echo "runtime-timing: cannot read jobs for run $id" >&2
    continue
  fi
  jq -n --slurpfile r "$entry/run.json" --slurpfile j "$entry/jobs.json" \
    '{run: $r[0], jobs: $j[0].jobs}' > "$entry/entry.json"
  jq -s '.[0] + [.[1]]' "$INPUT_JSON" "$entry/entry.json" > "$entry/input.next"
  cp "$entry/input.next" "$INPUT_JSON"
done

# Only successful default-branch collectors are candidates. Re-read each run's
# repository/event/branch/workflow identity and verify its revision is an ancestor
# of this pinned checkout BEFORE downloading artifacts. Never execute downloaded code.
trusted_ids=""
for hist in $(gh run list --repo "$GH_REPO" --workflow runtime-build-timing.yml \
    --branch "$default_branch" --status success --limit "${HISTORY_LIMIT:-30}" \
    --json databaseId -q '.[].databaseId'); do
  [[ "$hist" =~ ^[0-9]+$ && "$hist" != "$GITHUB_RUN_ID" ]] || continue
  history_run="$(mktemp -d)"
  if ! gh api "repos/$GH_REPO/actions/runs/$hist" > "$history_run/run.json"; then continue; fi
  sha="$(jq -r '.head_sha // ""' "$history_run/run.json")"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]] || ! git merge-base --is-ancestor "$sha" "$collector_sha"; then
    echo "runtime-timing: exclude collector $hist (revision not in trusted default-branch history)" >&2
    continue
  fi
  jq '. + {revision_is_ancestor: true}' "$history_run/run.json" > "$history_run/verified.json"
  if ! node agent-harness/collect-runtime-timing.mjs --validate-collector "$history_run/verified.json" --trust "$TRUST_JSON"; then
    echo "runtime-timing: exclude collector $hist (untrusted Actions provenance)" >&2
    continue
  fi
  jq --slurpfile prior "$history_run/verified.json" '.collectors += $prior' "$TRUST_JSON" > "$history_run/trust.next"
  cp "$history_run/trust.next" "$TRUST_JSON"
  if gh run download --repo "$GH_REPO" "$hist" -n runtime-timing-evidence -D "$TIMING_HISTORY/$hist"; then
    trusted_ids="$trusted_ids $hist"
  fi
done
# Validate sample schema/revision and compare its provenance against API metadata.
# Old or missing provenance is excluded, never re-signed by the current collector.
for hist in $trusted_ids; do
  node agent-harness/collect-runtime-timing.mjs --import-history "$TIMING_HISTORY/$hist" \
    --out-dir "$OUT_DIR" --trust "$TRUST_JSON" --producer-run-id "$hist"
done
echo "runtime-timing: collected $(jq 'length' "$INPUT_JSON") source run payloads"
