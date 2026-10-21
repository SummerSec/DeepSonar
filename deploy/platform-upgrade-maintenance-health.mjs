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
