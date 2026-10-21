// Corrupt only this disposable fixture's backup after the real backup actor verifies it.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {dc, query} from './platform-upgrade-maintenance.fixture.mjs';

export async function rehearseBackupRejection({config, fixture, evidence, marker, actors, approved, execute, assertSource, stateOf, secretsOf, snapshot}) {
  const io = actors(config, fixture), hash = await approved(io, config), backup = io.backup;
  let injected = false, checksumRejected = false, before;
  const candidate = io.candidate;
  io.candidate = async state => {
    try {return await candidate(state);}
    catch (error) {
      assert.equal(error.message, 'backup checksum mismatch');
      checksumRejected = true; throw error;
    }
  };
  io.backup = async state => {
    const receipt = await backup(state), saved = await secretsOf(fixture, state);
    before = snapshot(fixture, {role: saved.admin.role, database: saved.source.database});
    assert.equal(before.paused, true);
    assert.equal(receipt.file, `maintenance-${state.generation}.dump.gz`);
    const path = join(fixture.directory, '.upgrade', receipt.file), bytes = await readFile(path);
    assert.ok(bytes.length > 32); bytes[Math.floor(bytes.length / 2)] ^= 1;
    await writeFile(path, bytes, {mode: 0o600}); injected = true;
    return receipt;
  };
  await assert.rejects(execute(io, config, 'apply', hash), {code: 'MAINTENANCE_STEP_FAILED_ROLLED_BACK'});
  assert.equal(checksumRejected, true, 'actual candidate verification must reject the backup checksum');
  assert.equal(injected, true, 'real verified backup must precede corruption');
  const state = await stateOf(fixture); assert.equal(state.status, 'rolled_back');
  assert.ok(state.receipts.backup); assert.equal(state.receipts.candidate, undefined);
  const saved = await assertSource(config, fixture, state, marker), identity = {role: saved.admin.role, database: saved.source.database};
  assert.deepEqual(snapshot(fixture, identity), before, 'backup rejection must preserve paused source business rows');
  assert.equal(query(fixture, `SELECT rolcanlogin FROM pg_roles WHERE rolname='${saved.source.role}'`, identity), 'f');
  assert.equal(query(fixture, `SELECT count(*) FROM pg_database WHERE datname='${saved.candidateDatabase}'`, identity), '0');
  assert.equal(dc(fixture, ['ps', '--status', 'running', '-q', 'scheduler', 'web', 'image-admission']), '');
  evidence.failure = 'BACKUP_CHECKSUM_MISMATCH';
  evidence.corruptionInjected = true; evidence.sourcePaused = true; evidence.sourceRowsUnchanged = true;
  evidence.oldRoleFenced = true; evidence.candidateCreated = false;
}
