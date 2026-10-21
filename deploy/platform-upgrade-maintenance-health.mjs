export async function verifyMaintenanceWeb({dc, webUrl, request = fetch}) {
  dc(['exec', '-T', 'web', 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]);
  if (!webUrl) return;
  const url = new URL(webUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('Web URL must use HTTPS or loopback HTTP');
  const response = await request(url, {redirect: 'error', signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('external Web HTTP verification failed');
}
export function assertMaintenanceDatabase(row, {state, saved, phase}) {
  if (!row || row.schema_version !== state.target.schema_version || row.phase !== phase || row.generation !== state.generation
      || row.runtime_role !== saved.runtime.role || row.target_version !== state.target.version
      || row.claims_paused !== (phase === 'preparing')) throw new Error('target database schema, generation or maintenance phase mismatch');
}

export function assertRollbackConnection(actual, saved) {
  if (actual.role !== saved.rollbackRuntime.role || actual.password !== saved.rollbackRuntime.password
      || actual.database !== saved.source.database || actual.port !== saved.source.port) throw new Error('rollback source database connection mismatch');
}

export function assertRollbackDatabase(row, {state, saved, preparing, maintenance}) {
  if (!row || row.schema_version !== state.plan.source_schema_version || row.claims_paused !== preparing
      || row.old_role_login !== false || row.runtime_login !== true || row.runtime_superuser !== false) throw new Error('rollback source schema, claims or database role mismatch');
  if (maintenance && (row.phase !== (preparing ? 'preparing' : 'active') || row.generation !== saved.rollbackGeneration
      || row.runtime_role !== saved.rollbackRuntime.role || row.target_version !== saved.source.values.DEEPSONAR_VERSION)) throw new Error('rollback source maintenance identity mismatch');
}
