#!/usr/bin/env bash
# #961 P0: assemble GitHub Actions run/job payloads for collect-runtime-timing.mjs
# and backfill evidence artifacts from previous collector runs.
#
# This script only READS the Actions API. It never decides whether a build is
# good, never edits a workflow, and never fabricates a missing duration.
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${INPUT_JSON:?INPUT_JSON is required}"
: "${OUT_DIR:?OUT_DIR is required}"
: "${TIMING_HISTORY:?TIMING_HISTORY is required}"

mkdir -p "$OUT_DIR" "$TIMING_HISTORY" "$(dirname "$INPUT_JSON")"
printf '[]\n' > "$INPUT_JSON"

# 1. Resolve run ids: the triggering run, explicit ids, or a recent ci backfill.
if [[ -n "${RUN_IDS:-}" ]]; then
  ids="${RUN_IDS//,/ }"
else
  limit="${RECENT_LIMIT:-20}"
  source_workflow="${SOURCE_WORKFLOW:-ci.yml}"
  ids="$(gh run list --repo "$GH_REPO" --workflow "$source_workflow" \
    --status completed --limit "$limit" --json databaseId -q '.[].databaseId' || true)"
fi

# 2. Fetch the run object and every page of its jobs for each id.
for id in $ids; do
  if [[ ! "$id" =~ ^[0-9]+$ ]]; then
    echo "runtime-timing: skip invalid run id: $id" >&2
    continue
  fi
  tmp="$(mktemp -d)"
  if ! gh api "repos/$GH_REPO/actions/runs/$id" > "$tmp/run.json"; then
    echo "runtime-timing: cannot read run $id" >&2
    rm -rf "$tmp"
    continue
  fi
  if ! gh api --paginate "repos/$GH_REPO/actions/runs/$id/jobs?per_page=100" \
      | jq -s '{jobs: [.[].jobs[]]}' > "$tmp/jobs.json"; then
    echo "runtime-timing: cannot read jobs for run $id" >&2
    rm -rf "$tmp"
    continue
  fi
  jq -n --slurpfile r "$tmp/run.json" --slurpfile j "$tmp/jobs.json" \
    '{run: $r[0], jobs: $j[0].jobs}' > "$tmp/entry.json"
  jq -s '.[0] + [.[1]]' "$INPUT_JSON" "$tmp/entry.json" > "$tmp/input.json"
  mv "$tmp/input.json" "$INPUT_JSON"
  rm -rf "$tmp"
done

# 3. Backfill prior evidence. A single CI run can never produce three
# comparable cold/warm/invalidated samples, so historical artifacts are the
# only honest way to reach the P95 threshold.
for hist in $(gh run list --repo "$GH_REPO" --workflow runtime-build-timing.yml \
    --status success --limit "${HISTORY_LIMIT:-30}" \
    --json databaseId -q '.[].databaseId' || true); do
  gh run download --repo "$GH_REPO" "$hist" -n runtime-timing-evidence \
    -D "$TIMING_HISTORY/$hist" > /dev/null 2>&1 || true
done
find "$TIMING_HISTORY" -type f -name '*.json' ! -name '*.report.json' \
  -exec cp -n {} "$OUT_DIR/" \; 2> /dev/null || true

echo "runtime-timing: collected $(jq 'length' "$INPUT_JSON") run payloads, $(find "$OUT_DIR" -name '*.json' | wc -l) evidence files"
