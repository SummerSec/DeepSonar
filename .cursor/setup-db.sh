#!/usr/bin/env bash
# Provision a self-managed PostgreSQL cluster for DeepSonar local development.
# Idempotent: safe to run repeatedly. Runs entirely as the current (non-root)
# user so no privileged access is needed at boot time.
set -euo pipefail

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n1)"
if [ -z "${PG_BIN}" ]; then
  echo "PostgreSQL server binaries not found under /usr/lib/postgresql/*/bin" >&2
  exit 1
fi
export PATH="${PG_BIN}:${PATH}"

PGDATA="${PGDATA:-${HOME}/pgdata}"
PGPORT="${PGPORT:-5432}"
PGLOG="${HOME}/pgdata.log"
DB_USER="deepsonar"
DB_PASS="deepsonar"
DB_NAME="deepsonar"

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  echo "==> Initializing PostgreSQL cluster at ${PGDATA}"
  rm -rf "${PGDATA}"
  # Superuser = DB_USER so the app connection string owns the cluster.
  printf '%s' "${DB_PASS}" > /tmp/.pgpw
  initdb -D "${PGDATA}" -U "${DB_USER}" --auth-local=trust --auth-host=md5 \
    --pwfile=/tmp/.pgpw --encoding=UTF8 >/dev/null
  rm -f /tmp/.pgpw
  {
    echo "listen_addresses = '127.0.0.1'"
    echo "port = ${PGPORT}"
    echo "unix_socket_directories = '/tmp'"
  } >> "${PGDATA}/postgresql.conf"
fi

is_running() {
  pg_ctl -D "${PGDATA}" status >/dev/null 2>&1
}

if ! is_running; then
  echo "==> Starting PostgreSQL (${PGDATA}, port ${PGPORT})"
  pg_ctl -D "${PGDATA}" -l "${PGLOG}" -o "-p ${PGPORT}" -w start
fi

# Wait for readiness (admin ops use the trust-authenticated unix socket in /tmp).
for _ in $(seq 1 30); do
  if pg_isready -h /tmp -p "${PGPORT}" -U "${DB_USER}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Ensure the application database exists (cluster superuser == DB_USER).
if ! psql -h /tmp -p "${PGPORT}" -U "${DB_USER}" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  echo "==> Creating database ${DB_NAME}"
  createdb -h /tmp -p "${PGPORT}" -U "${DB_USER}" "${DB_NAME}"
fi

echo "==> PostgreSQL ready: postgres://${DB_USER}@127.0.0.1:${PGPORT}/${DB_NAME}"
