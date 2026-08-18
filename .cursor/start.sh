#!/usr/bin/env bash
# DeepSonar Cloud Agent start: per-boot reconciliation. Ensures the PostgreSQL
# cluster is running (data dir is durable across boots). Idempotent and returns
# after readiness; the scheduler/web dev servers run as terminals.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "${REPO_ROOT}/.cursor/setup-db.sh"
