import {randomUUID, randomBytes, createHash} from 'node:crypto';
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const identifier = value => {if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('invalid database'); return `"${value}"`;};
export async function readSourceActivation({state, saved, scalar}) {
  const comment = await scalar({database: 'postgres', sql: `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=${literal(saved.source.database)}`});
  try {
    const value = JSON.parse(comment);
    if (value.schema === 'deepsonar.rollback-activation/v1' && value.operation_generation === state.generation && value.runtime_role === saved.rollbackRuntime.role && value.active === true) return value;
  } catch { /* Other database ownership comments are not activation receipts. */ }
  return null;
}
// The DB comment is a durable activation receipt, committed with claims and the
// source maintenance phase. A lost response must not authorize another rollback.
export async function resumeRollback({state, saved, scalar, rows, saveJournal, saveSecrets, configure, start, verify, inspectCandidate}) {
  const existing = await readSourceActivation({state, saved, scalar});
  if (!existing && !['rolled_back', 'rollback_resuming'].includes(state.status)) throw new Error('only a verified paused rollback may be resumed');
  if (existing) {
    await start(); await verify();
    await saveJournal({...state, status: 'rollback_resumed', source_activation: existing});
    return {status: 'rollback_resumed', generation: existing.generation};
  }
  if ((await inspectCandidate()).status !== 'inactive' || state.activation || state.receipts.activate) throw new Error('active or uncertain target cannot resume source');
  const paused = await scalar({database: saved.source.database, sql: "SELECT claims_paused AND claims_pause_reason='platform_upgrade' FROM global_settings WHERE id='global'"});
  if (paused !== true) throw new Error('source is not safely paused');
  // Older Scheduler APIs cannot admit remote worker generations. Keep those
  // workers and the source stopped rather than claim a fence they do not have.
  const maintenance = await scalar({database: saved.source.database, sql: "SELECT to_regclass('public.platform_upgrade_state') IS NOT NULL"});
  if (!maintenance && saved.inventory.nodes.length) throw new Error('source version cannot safely resume managed nodes; keep them fenced');
  saved.rollbackGeneration ??= randomUUID();
  saved.rollbackWorkerToken ??= randomBytes(32).toString('hex');
  await saveSecrets(saved);
  const previous_comment = await scalar({database: 'postgres', sql: `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=${literal(saved.source.database)}`});
  const receipt = {schema: 'deepsonar.rollback-activation/v1', active: true, operation_generation: state.generation,
    generation: saved.rollbackGeneration, runtime_role: saved.rollbackRuntime.role, version: saved.source.values.DEEPSONAR_VERSION, previous_comment};
  await saveJournal({...state, status: 'rollback_resuming', intent: 'activateSource', source_activation_intent: receipt});
  await configure(maintenance);
  const phase = maintenance ? `UPDATE platform_upgrade_state SET phase='active',generation=${literal(saved.rollbackGeneration)},runtime_role=${literal(saved.rollbackRuntime.role)},target_version=${literal(receipt.version)},worker_generation_token_hash=${literal(createHash('sha256').update(saved.rollbackWorkerToken).digest('hex'))} WHERE id='global';` : '';
  await rows({database: saved.source.database, sql: `BEGIN;
SELECT id FROM global_settings WHERE id='global' FOR UPDATE;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM global_settings WHERE id='global' AND claims_paused AND claims_pause_reason='platform_upgrade') THEN RAISE EXCEPTION 'source pause changed'; END IF; END$$;
${phase}
UPDATE global_settings SET claims_paused=false,claims_pause_reason=NULL,claims_pause_note=NULL,claims_paused_by=NULL,claims_paused_at=NULL WHERE id='global';
COMMENT ON DATABASE ${identifier(saved.source.database)} IS ${literal(JSON.stringify(receipt))}; COMMIT;`});
  await saveJournal({...state, status: 'rollback_resuming', source_activation: receipt, intent: 'startSource'});
  await start(); await verify();
  await saveJournal({...state, status: 'rollback_resumed', source_activation: receipt, intent: null});
  return {status: 'rollback_resumed', generation: receipt.generation};
}
