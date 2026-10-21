import type { FastifyInstance } from "fastify";

export interface PlatformUpgradeState {
  phase: string;
  generation: string;
  runtime_role: string;
  target_version: string;
  current_role: string;
}
export interface PlatformMaintenanceIdentity { generation: string; version: string }
export function maintenanceIdentityMatches(state: PlatformUpgradeState | null, identity: PlatformMaintenanceIdentity): boolean {
  if (!state) return false;
  if (!identity.generation) return state.phase === "active" && state.generation === "" && state.runtime_role === "";
  return state.generation === identity.generation && state.runtime_role === state.current_role
    && state.target_version === identity.version && ["preparing", "active"].includes(state.phase);
}

/** Stops are registered before starting the next service, so partial startup
 * failures and every closed transition stop all services already started.
 * Stopping a timer is not cancellation of an external operation already sent;
 * the host must drain and fence DB roles before taking/restoring a snapshot.
 */
export function createPlatformMaintenanceGate(deps: {
  readState: () => Promise<PlatformUpgradeState | null>;
  identity: PlatformMaintenanceIdentity;
  start: (registerStop: (stop: () => void) => void) => void;
  onClose?: () => void;
}) {
  let state: PlatformUpgradeState | null = null;
  let matched = false;
  let bootReady = false;
  let active = false;
  let closed = false;
  let refreshPending: Promise<void> | null = null;
  let stops: Array<() => void> = [];
  const closeHandlers: Array<() => void> = [];
  const stop = () => {
    active = false;
    const current = stops; stops = [];
    for (const close of current.reverse()) { try { close(); } catch { /* Keep closing remaining services. */ } }
    deps.onClose?.();
    for (const close of closeHandlers) { try { close(); } catch { /* Close other connections too. */ } }
  };
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (refreshPending) return refreshPending;
    refreshPending = (async () => {
      try { state = await deps.readState(); matched = maintenanceIdentityMatches(state, deps.identity); }
      catch { state = null; matched = false; }
      if (closed || !matched || !bootReady || state?.phase !== "active") { stop(); return; }
      if (active) return;
      try {
        deps.start((close) => stops.push(close));
        active = true;
      } catch { stop(); matched = false; }
    })().finally(() => { refreshPending = null; });
    return refreshPending;
  };
  return {
    refresh,
    onClose: (close: () => void) => { closeHandlers.push(close); },
    setBootReady: () => { bootReady = true; },
    active: () => active,
    identityMatches: () => matched,
    status: () => ({
      maintenance: !active,
      maintenance_ready: matched && bootReady,
      upgrade_phase: state?.phase ?? "unavailable",
      upgrade_generation: state?.generation ?? "",
      upgrade_runtime_role: state?.runtime_role ?? "",
      upgrade_target_version: state?.target_version ?? "",
    }),
    close: () => { closed = true; matched = false; stop(); },
  };
}
export type PlatformMaintenanceGate = ReturnType<typeof createPlatformMaintenanceGate>;

/** Install before auth and WebSocket route registration: even GET and upgrade
 * requests must not reach business handlers during maintenance. Health bypasses
 * the usual runtime probe handler while closed and performs no upstream I/O.
 */
export function registerPlatformMaintenanceGuard(app: FastifyInstance, gate: PlatformMaintenanceGate, version: string): void {
  gate.onClose(() => {
    for (const socket of app.websocketServer?.clients ?? []) socket.terminate();
  });
  app.addHook("onRequest", async (request, reply) => {
    await gate.refresh();
    if (gate.active()) return;
    if (request.method === "GET" && request.url.split("?")[0] === "/health" && !request.headers.upgrade) {
      return reply.send({ ok: true, ready: false, version, ...gate.status() });
    }
    return reply.code(503).send({ error: "platform maintenance", error_code: "PLATFORM_MAINTENANCE" });
  });
}
