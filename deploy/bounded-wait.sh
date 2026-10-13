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
    -e 's/([[:alnum:]_]*(PASSWORD|SECRET|TOKEN|ACCESS_KEY|API_KEY|MASTER_KEY|BOOTSTRAP)[[:alnum:]_]*["]?[[:space:]]*[=:][[:space:]]*["]?)[^"[:space:],}]+/\1***/Ig' \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1***/I' \
    -e 's/(postgres(ql)?:\/\/[^:]+:)[^@]+@/\1***@/Ig'
}

ds_detect_container_runtime() {
  # Prefer explicit hint, then docker info, then DOCKER_HOST path.
  if [ -n "${DEEPSONAR_CONTAINER_RUNTIME:-}" ]; then
    printf '%s\n' "$DEEPSONAR_CONTAINER_RUNTIME"
    return 0
  fi
  info=$(ds_run_bounded 3 docker info 2>/dev/null || true)
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

ds_run_bounded() (
  # Subshell scope prevents nested probes from overwriting the caller's deadline.
  timeout_sec=$1
  shift
  case "$timeout_sec" in ''|*[!0-9]*|0) return 2 ;; esac
  # Use a marker to distinguish an actual deadline from a child that exits 124/137.
  # setsid lets the watchdog kill compose and its plugin as one process group.
  marker=$(mktemp) || return 1
  grouped=0
  exec 3<&0
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" <&3 3<&- &
    grouped=1
  else
    "$@" <&3 3<&- &
  fi
  cmd_pid=$!
  (
    timer_pid=""
    trap '[ -z "$timer_pid" ] || kill "$timer_pid" 2>/dev/null || true; [ -z "$timer_pid" ] || wait "$timer_pid" 2>/dev/null || true; exit 0' TERM INT HUP
    sleep "$timeout_sec" &
    timer_pid=$!
    wait "$timer_pid" || exit 0
    if kill -0 "$cmd_pid" 2>/dev/null; then
      echo timeout > "$marker"
      if [ "$grouped" -eq 1 ]; then
        kill -TERM -"$cmd_pid" 2>/dev/null || true
        sleep 1
        kill -KILL -"$cmd_pid" 2>/dev/null || true
      else
        # macOS has no setsid: snapshot descendants before terminating their parent.
        descendants=$(ps -eo pid=,ppid= | awk -v root="$cmd_pid" '
          { parent[$1]=$2 }
          function child(pid, p) { p=parent[pid]; return p==root || (p>1 && p!=pid && child(p)) }
          END { for (pid in parent) if (child(pid)) print pid }')
        kill -TERM "$cmd_pid" $descendants 2>/dev/null || true
        sleep 1
        kill -KILL "$cmd_pid" $descendants 2>/dev/null || true
      fi
    fi
  ) >/dev/null 2>&1 &
  watchdog=$!
  rc=0
  wait "$cmd_pid" || rc=$?
  if [ ! -s "$marker" ]; then kill "$watchdog" 2>/dev/null || true; fi
  wait "$watchdog" 2>/dev/null || true
  [ ! -s "$marker" ] || rc=124
  rm -f "$marker"
  return "$rc"
)

ds_wait_cmd() (
  # One wall-clock deadline includes time spent in the command, not just sleeps.
  timeout_sec=$1
  label=$2
  shift 2
  if [ "$1" = "--" ]; then shift; fi
  deadline=$(($(date +%s) + timeout_sec))
  while :; do
    remaining=$((deadline - $(date +%s)))
    [ "$remaining" -gt 0 ] || break
    probe_bound=$remaining
    [ "$probe_bound" -le 3 ] || probe_bound=3
    if ds_run_bounded "$probe_bound" "$@" >/dev/null 2>&1; then return 0; fi
    remaining=$((deadline - $(date +%s)))
    [ "$remaining" -gt 0 ] || break
    pause=${DEEPSONAR_PROBE_INTERVAL_SEC:-2}
    [ "$pause" -le "$remaining" ] || pause=$remaining
    sleep "$pause"
  done
  echo "[deploy] readiness timeout after ${timeout_sec}s: $label" >&2
  return 1
)

ds_wait_http() (
  url=$1
  timeout_sec=${2:-$DEEPSONAR_READY_TIMEOUT_SEC}
  label=${3:-$url}
  if command -v curl >/dev/null 2>&1; then
    ds_wait_cmd "$timeout_sec" "$label" -- curl -fsS --max-time 3 "$url"
  elif command -v wget >/dev/null 2>&1; then
    ds_wait_cmd "$timeout_sec" "$label" -- wget -q -O /dev/null --timeout=3 "$url"
  else
    echo "[deploy] curl/wget missing; cannot probe $label" >&2
    return 1
  fi
)

ds_compose_blocker_hint() {
  # Best-effort: name services still in health=starting / created / exited.
  # Args: docker compose prefix as "$@"
  {
    echo "[deploy] container status:"
    ds_run_bounded 3 "$@" ps -a 2>/dev/null || ds_run_bounded 3 "$@" ps 2>/dev/null || true
  } | ds_redact_secrets
  # Inspect health where possible (Compose v2 JSON may vary; keep best-effort).
  for svc in postgres silo silo-init opensandbox scheduler image-admission web; do
    cid=$(ds_run_bounded 3 "$@" ps -q "$svc" 2>/dev/null | head -1 || true)
    if [ -n "$cid" ]; then
      health=$(ds_run_bounded 3 docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)
      state=$(ds_run_bounded 3 docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)
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
    ds_run_bounded 3 docker version 2>/dev/null | ds_redact_secrets || true
    ds_run_bounded 3 docker compose version 2>/dev/null | ds_redact_secrets || true
  fi
  if command -v podman >/dev/null 2>&1; then
    echo "[deploy] podman:"
    ds_run_bounded 3 podman version 2>/dev/null | ds_redact_secrets || true
  fi
  ds_compose_blocker_hint "$@"
  echo "[deploy] recent logs (tail 80, redacted):"
  {
    ds_run_bounded 3 "$@" logs --tail 80 postgres silo silo-init scheduler image-admission web opensandbox 2>/dev/null \
      || ds_run_bounded 3 "$@" logs --tail 80 2>/dev/null \
      || true
  } | ds_redact_secrets
  echo "[deploy] ===== end diagnostics ====="
}

ds_infra_really_ready() (
  # Probe the actual compose services; a host port can belong to another stack.
  ds_run_bounded 3 "$@" exec -T postgres pg_isready -U deepsonar -d deepsonar >/dev/null 2>&1 || return 1
  ds_run_bounded 3 "$@" exec -T silo silo healthcheck ready >/dev/null 2>&1
)

ds_wait_infra_ready() (
  # Both dependencies share the same deadline.
  deadline=$(($(date +%s) + ${DEEPSONAR_READY_TIMEOUT_SEC:-180}))
  ds_wait_cmd "${DEEPSONAR_READY_TIMEOUT_SEC:-180}" postgres -- "$@" exec -T postgres pg_isready -U deepsonar -d deepsonar || return 1
  remaining=$((deadline - $(date +%s)))
  [ "$remaining" -gt 0 ] || return 1
  ds_wait_cmd "$remaining" silo -- "$@" exec -T silo silo healthcheck ready || return 1
  echo "[deploy] infra readiness ok (postgres + silo real probes)"
)

ds_wait_entry_ready() (
  port=$1
  timeout_sec=$2
  shift 2
  url="http://127.0.0.1:${port}/api/health"
  echo "[deploy] waiting for entry readiness: $url (bound ${timeout_sec}s)"
  deadline=$(($(date +%s) + timeout_sec))
  body=$(mktemp) || return 1
  trap 'rm -f "$body"' EXIT HUP INT TERM
  while :; do
    remaining=$((deadline - $(date +%s)))
    [ "$remaining" -gt 0 ] || break
    bound=$remaining
    [ "$bound" -le 3 ] || bound=3
    fetched=1
    if command -v curl >/dev/null 2>&1; then
      ds_run_bounded "$bound" curl -fsS --max-time "$bound" "$url" > "$body" 2>/dev/null && fetched=0
    elif command -v wget >/dev/null 2>&1; then
      ds_run_bounded "$bound" wget -q -O - --timeout="$bound" "$url" > "$body" 2>/dev/null && fetched=0
    else
      echo "[deploy] curl/wget missing; cannot probe entry" >&2
      return 1
    fi
    remaining=$((deadline - $(date +%s)))
    if [ "$fetched" -eq 0 ] && [ "$remaining" -gt 0 ]; then
      bound=$remaining
      [ "$bound" -le 3 ] || bound=3
      # Invoke the parser directly under the watchdog (functions are not execs).
      if ds_run_bounded "$bound" "$@" exec -T scheduler node -e 'let s=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{try{const h=JSON.parse(s); process.exit(h && h.ok===true && h.ready===true ? 0 : 1)}catch{process.exit(1)}})' < "$body" >/dev/null 2>&1; then return 0; fi
    fi
    remaining=$((deadline - $(date +%s)))
    [ "$remaining" -gt 0 ] || break
    pause=${DEEPSONAR_PROBE_INTERVAL_SEC:-2}
    [ "$pause" -le "$remaining" ] || pause=$remaining
    sleep "$pause"
  done
  echo "[deploy] readiness timeout after ${timeout_sec}s: $url (requires ok=true and ready=true)" >&2
  return 1
)

ds_service_state() (
  service=$1
  shift
  bound=${DS_SERVICE_TIMEOUT_SEC:-3}
  [ "$bound" -le 3 ] || bound=3
  deadline=$(($(date +%s) + bound))
  cid=$(ds_run_bounded "$bound" "$@" ps -a -q "$service" 2>/dev/null) || return 1
  [ -n "$cid" ] || return 1
  remaining=$((deadline - $(date +%s)))
  [ "$remaining" -gt 0 ] || return 1
  ds_run_bounded "$remaining" docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$cid" 2>/dev/null
)

ds_ensure_app_services_started() (
  echo "[deploy] controlled path: infra probes passed; starting app services with explicit dependency gates"
  services=$(ds_run_bounded 3 "$@" config --services) || return 1
  for svc in opensandbox silo-init image-admission scheduler web; do
    if printf '%s\n' "$services" | grep -qx "$svc"; then
      ds_run_bounded 120 "$@" up -d --no-deps "$svc" || return 1
      if [ "$svc" = silo-init ]; then
        deadline=$(($(date +%s) + ${DEEPSONAR_READY_TIMEOUT_SEC:-180}))
        while :; do
          remaining=$((deadline - $(date +%s)))
          [ "$remaining" -gt 0 ] || return 1
          state=$(DS_SERVICE_TIMEOUT_SEC=$remaining ds_service_state silo-init "$@") || return 1
          case "$state" in
            'exited 0') break ;;
            exited*|dead*) echo "[deploy] silo-init failed: $state" >&2; return 1 ;;
          esac
          [ "$(date +%s)" -lt "$deadline" ] || return 1
          sleep 1
        done
      fi
    fi
  done
)
