import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ident = value => '"' + value.replaceAll('"', '""') + '"';

// All transports are bound to the independent maintenance identity by the host.
// This module never receives its password, starts business services, or drops the source DB.
export function createCandidateManager({runSql, runRestore, runTargetCli, verifyFence, verifyBackup, sourceDatabase, operationId}) {
  if (!/^[a-f0-9]{32}$/.test(operationId) || typeof sourceDatabase !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(sourceDatabase) || sourceDatabase === `ds_upgrade_${operationId}`) throw new Error('invalid source or operation identity');
  const baseDatabase = `ds_upgrade_${operationId}`;
  let database = baseDatabase;
  async function checkCut(backup) {
    const fence = await verifyFence();
    if (fence?.ok !== true || fence.operation_id !== operationId || fence.source_database !== sourceDatabase) throw new Error('source fence not verified');
    const receipt = await verifyBackup(backup);
    if (receipt?.ok !== true || receipt.operation_id !== operationId || receipt.fence_epoch !== fence.epoch
        || receipt.source_database !== sourceDatabase || !validHash(receipt.sha256)) throw new Error('backup does not match fenced source');
    return receipt;
  }
  return {
    get database() { return database; },
    async restore(backup) {
      const receipt = await checkCut(backup);
      const existing = await runSql({database: 'postgres', sql: `SELECT datname,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname LIKE '${baseDatabase}%' ORDER BY datname`});
      if (!Array.isArray(existing)) throw new Error('invalid candidate inventory');
      const owned = existing.map(row => {try {return {...row, receipt: JSON.parse(row.marker)};} catch {return {...row, receipt: null};}})
        .find(row => row.receipt?.operation_id === operationId && row.receipt?.source_database === sourceDatabase && row.receipt?.backup_sha256 === receipt.sha256);
      if (owned) {
        if (!/^ds_upgrade_[a-f0-9]{32,40}$/.test(owned.datname) || owned.datname === sourceDatabase) throw new Error('invalid owned candidate');
        database = owned.datname;
        if (['restored', 'rebuilt'].includes(owned.receipt.phase)) {
          const state = await runSql({database, sql: "SELECT claims_paused FROM global_settings WHERE id='global'"});
          if (state?.[0]?.claims_paused !== true) throw new Error('existing candidate is not paused');
          return {operation_id: operationId, database, backup_sha256: receipt.sha256, fence_epoch: receipt.fence_epoch};
        }
        if (!['restoring', 'rebuilding'].includes(owned.receipt.phase)) throw new Error('candidate phase requires inspection');
        const candidateFence = await verifyFence({candidateDatabase: database});
        if (candidateFence?.ok !== true || candidateFence.activation !== 'inactive' || candidateFence.candidate_writes_blocked !== true) throw new Error('candidate write fence not verified');
        // Only an explicitly owned interrupted restore may be recreated. The
        // host must keep business identities fenced throughout this operation.
        await runSql({database: 'postgres', sql: `DROP DATABASE ${ident(database)}`});
      } else {
        const names = new Set(existing.map(row => row.datname));
        database = baseDatabase;
        for (let attempt = 1; names.has(database) || database === sourceDatabase; attempt++) {
          if (attempt > 100) throw new Error('candidate name allocation exhausted');
          database = baseDatabase + attempt.toString(16).padStart(8, '0');
        }
      }
      await runSql({database: 'postgres', sql: `CREATE DATABASE ${ident(database)} TEMPLATE template0`});
      const marker = phase => JSON.stringify({operation_id: operationId, source_database: sourceDatabase, backup_sha256: receipt.sha256, phase}).replaceAll("'", "''");
      await runSql({database: 'postgres', sql: `COMMENT ON DATABASE ${ident(database)} IS '${marker('restoring')}'`});
      // No default PUBLIC connect privilege; maintenance owner still has access.
      await runSql({database: 'postgres', sql: `REVOKE CONNECT ON DATABASE ${ident(database)} FROM PUBLIC`});
      await runRestore({database, backup, options: ['--exit-on-error', '--no-owner', '--no-privileges']});
      await runSql({database, sql: 'REVOKE CREATE ON SCHEMA public FROM PUBLIC'});
      const state = await runSql({database, sql: "SELECT claims_paused FROM global_settings WHERE id='global'"});
      if (state?.[0]?.claims_paused !== true) throw new Error('restored candidate is not paused');
      await runSql({database: 'postgres', sql: `COMMENT ON DATABASE ${ident(database)} IS '${marker('restored')}'`});
      return {operation_id: operationId, database, backup_sha256: receipt.sha256, fence_epoch: receipt.fence_epoch};
    },
    async plan(backup) {
      await checkCut(backup);
      return runTargetCli({action: 'plan', candidate_database: database});
    },
    async apply(backup, expectedPlanHash, {reset_role_identity = false} = {}) {
      const receipt = await checkCut(backup);
      if (!validHash(expectedPlanHash)) throw new Error('explicit approved plan hash required');
      const fence = await verifyFence({candidateDatabase: database});
      if (fence?.ok !== true || fence.activation !== 'inactive' || fence.candidate_writes_blocked !== true) throw new Error('candidate write fence not verified');
      const rows = await runSql({database: 'postgres', sql: `SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname='${database}'`});
      let previous;
      try { previous = JSON.parse(rows?.[0]?.marker); } catch { throw new Error('candidate ownership receipt missing'); }
      if (previous.operation_id !== operationId || previous.source_database !== sourceDatabase || previous.backup_sha256 !== receipt.sha256) throw new Error('candidate ownership receipt mismatch');
      if (previous.phase === 'rebuilt') {
        if (previous.plan_hash !== expectedPlanHash || previous.reset_role_identity !== reset_role_identity) throw new Error('rebuilt candidate approval mismatch');
        const current = await runTargetCli({action: 'plan', candidate_database: database, reset_role_identity});
        if (current?.ok !== true || current.plan?.source_schema_version !== current.plan?.target_schema_version || current.plan?.target_sql_sha256 !== previous.target_sql_sha256 || current.plan?.claims_paused !== true) throw new Error('rebuilt candidate verification failed');
        return {ok: true, applied: true, resumed: true, plan_hash: expectedPlanHash};
      }
      if (previous.phase !== 'restored') throw new Error('interrupted candidate must be restored before rebuild');
      const mark = async (phase, extra = {}) => {
        const value = JSON.stringify({...previous, phase, plan_hash: expectedPlanHash, reset_role_identity, ...extra}).replaceAll("'", "''");
        await runSql({database: 'postgres', sql: `COMMENT ON DATABASE ${ident(database)} IS '${value}'`});
      };
      await mark('rebuilding');
      const result = await runTargetCli({action: 'apply', candidate_database: database, expected_plan_hash: expectedPlanHash, verified_backup_sha256: receipt.sha256, reset_role_identity});
      if (result?.ok !== true) return result;
      if (!validHash(result.plan?.target_sql_sha256)) throw new Error('invalid target rebuild receipt');
      await mark('rebuilt', {target_sql_sha256: result.plan.target_sql_sha256});
      return result;
    },
  };
}

export function backupBytesDigest(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('empty backup');
  return hash(bytes);
}
