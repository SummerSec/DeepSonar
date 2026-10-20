// Shared host upgrade state machine. Node >= 22; no Scheduler/Job execution path.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export function forwardVersion(current, target) {
  const parse = value => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('upgrade requires stable X.Y.Z versions');
    return value.split('.').map(BigInt);
  };
  const a = parse(current), b = parse(target);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}

export function assertDrained(status) {
  if (status.claims_paused !== true || status.reason !== 'platform_upgrade'
      || status.drained !== true || status.in_flight?.total !== 0
      || status.effect_pending_attempts !== 0 || status.unknown_effect_attempts !== 0) {
    throw new Error('platform is not safely paused and drained (including unresolved effects)');
  }
}

export function verifyBackup(bytes, expectedHash) {
  if (!bytes?.length) throw new Error('empty backup');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash && hash !== expectedHash) throw new Error('backup checksum mismatch');
  const dump = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  if (dump.length <= 5 || dump.subarray(0, 5).toString() !== 'PGDMP') throw new Error('backup is not a nonempty PostgreSQL custom archive');
  return { hash, dump };
}

// Every adapter operation is awaited. Journal writes precede mutating operations;
// failed/interrupted runs require explicit rollback. Never infer success from a step name.
export async function upgrade(action, io) {
  if (!['check', 'apply', 'rollback'].includes(action)) throw new Error('expected check, apply or rollback');
  return io.lock(async () => {
    const previous = await io.readState();
    if (action === 'rollback') return rollback(io, previous);
    if (action === 'apply' && previous && !['complete', 'rolled_back'].includes(previous.stage)) {
      throw new Error('unfinished upgrade: inspect journal and run rollback; refusing to overwrite recovery evidence');
    }
    const target = await io.release(); // Trusted official source + manifest/index/child inspection.
    const current = await io.current();
    if (!forwardVersion(current.version, target.version)) throw new Error('target must be newer than the current deployment');
    await io.pull(target);
    await io.preflight(target);
    const plan = { current, target, schemaRebuildRequired: current.schema !== target.schema_version };
    if (action === 'check') return plan;
    if (plan.schemaRebuildRequired) {
      await io.schemaPlan(target);
      throw new Error('schema rebuild requires reviewed plan and manual rebuild; no automatic schema migration');
    }
    if ((await io.claims()).claims_paused !== false) throw new Error('platform already paused; preserve existing operator pause');
    const state = { format: 1, stage: 'pause_requested', current, target, createdAt: new Date().toISOString() };
    const save = async stage => { state.stage = stage; await io.writeState(state); };
    await save('pause_requested');
    // No finally-resume: even an ambiguous pause response must stay in recovery state.
    await io.pause();
    await io.drain();
    assertDrained(await io.claims());
    await save('backup_started');
    state.backup = await io.backup();
    await io.verifyBackup(state.backup);
    await save('backup_verified');
    assertDrained(await io.claims());
    await save('stopping');
    await io.stop();
    await save('switching');
    await io.configure(target);
    await save('starting');
    await io.start();
    await io.verify(target);
    assertDrained(await io.claims());
    await save('verified_paused');
    await save('resume_requested');
    await io.resume();
    await save('complete');
    return state;
  });
}

async function rollback(io, state) {
  if (!state || state.format !== 1 || ['complete', 'rolled_back'].includes(state.stage)) {
    throw new Error('no interrupted upgrade to roll back');
  }
  if (!['pause_requested', 'backup_started', 'backup_verified', 'stopping', 'switching', 'starting', 'verified_paused', 'resume_requested', 'reverting', 'rollback_verifying'].includes(state.stage)) throw new Error('invalid recovery stage');
  // A durable resume intent is an uncertainty boundary: it may already have
  // admitted new work. Require operator reconciliation, never restore snapshots.
  if (state.stage === 'resume_requested') throw new Error('resume outcome ambiguous; operator reconciliation required');
  assertDrained(await io.recoveryClaims());
  const changed = ['stopping', 'switching', 'starting', 'verified_paused', 'reverting', 'rollback_verifying'].includes(state.stage);
  if (changed) {
    if (!state.backup) throw new Error('missing verified recovery backup');
    await io.verifyBackup(state.backup);
    if (state.current.schema !== state.target.schema_version) throw new Error('cross-schema rollback requires offline manual recovery');
    state.stage = 'reverting'; await io.writeState(state);
    await io.stop();
    // Same-schema upgrade: preserve DB, including new pending Jobs and management
    // writes accepted while paused. A snapshot must never erase those writes.
    await io.forcePaused();
    await io.configure(state.current);
    state.stage = 'rollback_verifying'; await io.writeState(state);
    await io.start();
    await io.verify(state.current);
  }
  assertDrained(await io.claims());
  state.stage = 'rolled_back'; await io.writeState(state);
  // Deliberately leave pause in place for an operator to verify and resume explicitly.
  return state;
}
