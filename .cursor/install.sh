#!/usr/bin/env bash
# DeepSonar Cloud Agent install: idempotent repository bootstrap run after
# checkout. Prepares the PostgreSQL cluster, workspace dependencies, prebuilt
# workspace packages, and a local dev .env. Must terminate (no daemons here).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# System packages: PostgreSQL server (dev database) and a `python` alias
# (repo smoke scripts invoke `python`, but the base image ships only python3).
# apt-get is idempotent, so this is safe to re-run.
NEED_PKGS=()
command -v initdb >/dev/null 2>&1 || ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || NEED_PKGS+=(postgresql postgresql-contrib)
command -v python >/dev/null 2>&1 || NEED_PKGS+=(python-is-python3)
if [ "${#NEED_PKGS[@]}" -gt 0 ]; then
  echo "==> Installing system packages: ${NEED_PKGS[*]}"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NEED_PKGS[@]}"
fi

echo "==> Provisioning PostgreSQL"
bash "${REPO_ROOT}/.cursor/setup-db.sh"

echo "==> Installing workspace dependencies (pnpm)"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

echo "==> Prebuilding workspace packages used by dev servers"
pnpm -r --filter @deepsonar/shared-types --filter @deepsonar/plane-client \
  --filter @deepsonar/runtime-sandbox build

if [ ! -f "${REPO_ROOT}/.env" ]; then
  echo "==> Creating local dev .env (AGENT_MODE=fake)"
  cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
  # Local dev runs the state machine with the built-in NoopRunner (no Docker
  # sandbox images required); the scheduler applies the schema baseline to the
  # empty database on first boot.
  sed -i 's/^AGENT_MODE=real/AGENT_MODE=fake/' "${REPO_ROOT}/.env"
  # The built-in .env parser keeps everything after '=' as the value, so an
  # inline comment would leak into string settings. Normalize the one that
  # matters (a bind host must be a bare address).
  sed -i 's/^SCHEDULER_HOST=.*/SCHEDULER_HOST=127.0.0.1/' "${REPO_ROOT}/.env"
fi

echo "==> Install complete"
