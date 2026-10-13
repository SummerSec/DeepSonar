#!/usr/bin/env sh
# DeepSonar deploy bounded wait / readiness helpers (#726).
# Sourced by deploy.sh. Safe to source from tests with mocked docker/curl.

# Defaults (overridable via env before source, or DEEPSONAR_* at call time).
: "${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC:=600}"
: "${DEEPSONAR_READY_TIMEOUT_SEC:=180}"
: "${DEEPSONAR_COMPOSE_DEPENDS_ON:=auto}"
: "${DEEPSONAR_PROBE_INTERVAL_SEC:=2}"

ds_redact_secrets() {
  # Redact common secret shapes from diagnostic streams (stdin → stdout).
  sed -E \
    -e 's/(PASSWORD|SECRET|TOKEN|ACCESS_KEY|SECRET_ACCESS_KEY|API_KEY|MASTER_KEY|BOOTSTRAP)[=:][[:space:]]*[^[:space:]]+/\1=***/Ig' \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1***/I' \
    -e 's/(postgres:\/\/[^:]+:)[^@]+@/\1***@/g'
}

ds_detect_container_runtime() {
  # Prefer explicit hint, then docker info, then DOCKER_HOST path.
  if [ -n "${DEEPSONAR_CONTAINER_RUNTIME:-}" ]; then
    printf '%s\n' "$DEEPSONAR_CONTAINER_RUNTIME"
    return 0
  fi
  info=$(docker info 2>/dev/null || true)
  case "$info" in
    *[Pp]odman*) printf 'podman\n'; return 0 ;;
  esac
  case "${DOCKER_HOST:-}" in
    *podman*) printf 'podman\n'; return 0 ;;
  esac
  printf 'docker\n'
}

ds_should_use_started_depends() {
  mode=${DEEPSONAR_COMPOSE_DEPENDS_ON:-auto}
  case "$mode" in
    started|service_started) return 0 ;;
    healthy|service_healthy) return 1 ;;
    auto|"")
      [ "$(ds_detect_container_runtime)" = "podman" ]
      return $?
      ;;
    *)
      echo "[deploy] unknown DEEPSONAR_COMPOSE_DEPENDS_ON=$mode (use auto|healthy|started)" >&2
      return 1
      ;;
  esac
}

ds_run_bounded() {
  # ds_run_bounded TIMEOUT_SEC COMMAND [ARGS...]
  # Runs COMMAND with a wall-clock bound. Exit 124 on timeout (GNU timeout convention).
  timeout_sec=$1
  shift
  if [ "$timeout_sec" -le 0 ]; then
    "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    # --foreground keeps signals with the child when available (GNU coreutils).
    if timeout --help 2>&1 | grep -q -- '--foreground'; then
      timeout --foreground "$timeout_sec" "$@"
    else
      timeout "$timeout_sec" "$@"
    fi
    return $?
  fi
  # Portable fallback: background + poll.
  "$@" &
  cmd_pid=$!
  elapsed=0
  while kill -0 "$cmd_pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_sec" ]; then
      kill "$cmd_pid" 2>/dev/null || true
      wait "$cmd_pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$cmd_pid"
  return $?
}

ds_wait_http() {
  # ds_wait_http URL TIMEOUT_SEC [LABEL]
  url=$1
  timeout_sec=${2:-$DEEPSONAR_READY_TIMEOUT_SEC}
  label=${3:-$url}
  interval=${DEEPSONAR_PROBE_INTERVAL_SEC:-2}
  elapsed=0
  while [ "$elapsed" -lt "$timeout_sec" ]; do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
        return 0
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q -O /dev/null --timeout=3 "$url" 2>/dev/null; then
        return 0
      fi
    else
      echo "[deploy] curl/wget missing; cannot probe $label" >&2
      return 1
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  echo "[deploy] readiness timeout after ${timeout_sec}s: $label ($url)" >&2
  return 1
}

ds_wait_cmd() {
  # ds_wait_cmd TIMEOUT_SEC LABEL -- COMMAND...
  timeout_sec=$1
  label=$2
  shift 2
  if [ "$1" = "--" ]; then shift; fi
  interval=${DEEPSONAR_PROBE_INTERVAL_SEC:-2}
  elapsed=0
  while [ "$elapsed" -lt "$timeout_sec" ]; do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  echo "[deploy] readiness timeout after ${timeout_sec}s: $label" >&2
  return 1
}

ds_compose_blocker_hint() {
  # Best-effort: name services still in health=starting / created / exited.
  # Args: docker compose prefix as "$@"
  {
    echo "[deploy] container status:"
    "$@" ps -a 2>/dev/null || "$@" ps 2>/dev/null || true
  } | ds_redact_secrets
  # Inspect health where possible (Compose v2 JSON may vary; keep best-effort).
  for svc in postgres silo silo-init opensandbox scheduler image-admission web; do
    cid=$("$@" ps -q "$svc" 2>/dev/null | head -1 || true)
    if [ -n "$cid" ]; then
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)
      state=$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)
      echo "[deploy]   $svc: state=$state health=$health"
      if [ "$health" = "starting" ] || [ "$state" = "created" ]; then
        echo "[deploy] blocker candidate: $svc (state=$state health=$health)"
      fi
    fi
  done
}

ds_dump_deploy_diagnostics() {
  # ds_dump_deploy_diagnostics COMPOSE_PREFIX...
  # Prints operator-facing diagnostics; secrets redacted.
  echo "[deploy] ===== deploy diagnostics (#726) ====="
  echo "[deploy] timestamp: $(date -Iseconds 2>/dev/null || date)"
  echo "[deploy] container runtime: $(ds_detect_container_runtime)"
  echo "[deploy] DEEPSONAR_COMPOSE_DEPENDS_ON=${DEEPSONAR_COMPOSE_DEPENDS_ON:-auto}"
  echo "[deploy] DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC=${DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC:-600}"
  echo "[deploy] DEEPSONAR_READY_TIMEOUT_SEC=${DEEPSONAR_READY_TIMEOUT_SEC:-180}"
  if command -v docker >/dev/null 2>&1; then
    echo "[deploy] docker:"
    docker version 2>/dev/null | ds_redact_secrets || true
    docker compose version 2>/dev/null || true
  fi
  if command -v podman >/dev/null 2>&1; then
    echo "[deploy] podman:"
    podman version 2>/dev/null | ds_redact_secrets || true
  fi
  ds_compose_blocker_hint "$@"
  echo "[deploy] recent logs (tail 80, redacted):"
  {
    "$@" logs --tail 80 postgres silo silo-init scheduler image-admission web opensandbox 2>/dev/null \
      || "$@" logs --tail 80 2>/dev/null \
      || true
  } | ds_redact_secrets
  echo "[deploy] ===== end diagnostics ====="
}

ds_probe_postgres() {
  # Args: compose prefix "$@"
  "$@" exec -T postgres pg_isready -U deepsonar -d deepsonar
}

ds_probe_silo_http() {
  # Host-published Silo API (default 127.0.0.1:9000).
  bind=${SILO_API_BIND:-127.0.0.1:9000}
  hostport=${bind##*:}
  case "$bind" in
    *:*) ;;
    *) hostport=9000 ;;
  esac
  url="http://127.0.0.1:${hostport}/minio/health/live"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1
  else
    return 1
  fi
}

ds_probe_silo_exec() {
  # Args: compose prefix "$@"
  "$@" exec -T silo silo healthcheck ready
}

ds_infra_really_ready() {
  # True when postgres + silo accept real probes (health label may still be wrong).
  # Args: compose prefix "$@"
  if ! ds_probe_postgres "$@" >/dev/null 2>&1; then
    return 1
  fi
  if ds_probe_silo_http; then
    return 0
  fi
  ds_probe_silo_exec "$@" >/dev/null 2>&1
}

ds_wait_infra_ready() {
  # Args: compose prefix "$@"
  timeout_sec=${DEEPSONAR_READY_TIMEOUT_SEC:-180}
  interval=${DEEPSONAR_PROBE_INTERVAL_SEC:-2}
  elapsed=0
  while [ "$elapsed" -lt "$timeout_sec" ]; do
    if ds_infra_really_ready "$@"; then
      echo "[deploy] infra readiness ok (postgres + silo real probes)"
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  echo "[deploy] infra readiness timeout after ${timeout_sec}s (postgres/silo)" >&2
  return 1
}

ds_wait_entry_ready() {
  # Final success gate: configured entry port /api/health.
  port=${1:-8080}
  timeout_sec=${2:-$DEEPSONAR_READY_TIMEOUT_SEC}
  url="http://127.0.0.1:${port}/api/health"
  echo "[deploy] waiting for entry readiness: $url (bound ${timeout_sec}s)"
  ds_wait_http "$url" "$timeout_sec" "web entry :${port}/api/health"
}

ds_ensure_app_services_started() {
  # After a timed-out service_healthy up, if infra is really ready, start remaining
  # app services without waiting on Compose health gates (--no-deps).
  # Args: compose prefix "$@"
  echo "[deploy] controlled path: infra probes passed; starting app services without health gates"
  # Order: opensandbox before scheduler; silo-init before scheduler; web last.
  for svc in opensandbox silo-init image-admission scheduler web; do
    if "$@" config --services 2>/dev/null | grep -qx "$svc"; then
      echo "[deploy]   up -d --no-deps $svc"
      if ! ds_run_bounded 120 "$@" up -d --no-deps "$svc"; then
        echo "[deploy] failed to start $svc on controlled path" >&2
        return 1
      fi
    fi
  done
  return 0
}
