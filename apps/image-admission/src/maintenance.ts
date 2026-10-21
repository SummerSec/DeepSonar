export interface AdmissionUpgradeState {
  phase: string; generation: string; runtime_role: string; current_role: string; target_version: string;
}
export function admissionMaintenanceAllowsWork(state: AdmissionUpgradeState | null, identity: { generation: string; version: string }): boolean {
  if (!state || state.phase !== "active") return false;
  if (!identity.generation) return state.generation === "" && state.runtime_role === "";
  return state.generation === identity.generation && state.runtime_role === state.current_role && state.target_version === identity.version;
}
export class AdmissionMaintenanceBlocked extends Error {
  constructor() { super("image admission is paused for platform maintenance"); }
}
/** Read errors and missing rows are closed. Concurrent polling cannot start the
 * loop set twice. Long-running external work is fenced separately by the host. */
export function createAdmissionMaintenanceGate(deps: {
  readState: () => Promise<AdmissionUpgradeState | null>;
  identity: { generation: string; version: string };
  start: (registerStop: (stop: () => void) => void) => void;
}) {
  let running = false;
  let closed = false;
  let pending: Promise<void> | null = null;
  let stops: Array<() => void> = [];
  async function authorized(): Promise<boolean> {
    if (closed) return false;
    try { const state = await deps.readState(); return !closed && admissionMaintenanceAllowsWork(state, deps.identity); } catch { return false; }
  }
  const stop = () => {
    running = false;
    const current = stops; stops = [];
    for (const close of current.reverse()) { try { close(); } catch { /* Stop every loop. */ } }
  };
  return {
    authorized,
    async requireActive() { if (!await authorized()) throw new AdmissionMaintenanceBlocked(); },
    refresh(): Promise<void> {
      if (pending) return pending;
      pending = (async () => {
        if (!await authorized()) { stop(); return; }
        if (running || closed) return;
        try { deps.start((close) => stops.push(close)); running = true; } catch { stop(); }
      })().finally(() => { pending = null; });
      return pending;
    },
    close() { closed = true; stop(); },
  };
}
