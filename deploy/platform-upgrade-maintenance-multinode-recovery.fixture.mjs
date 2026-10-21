// Real managed-node second-generation recovery; all injected faults stop actual services.
import assert from 'node:assert/strict';
import {runMaintenanceUpgrade} from './platform-upgrade-maintenance.mjs';
import {createMaintenanceMultinodeFixture} from './platform-upgrade-maintenance-multinode.fixture.mjs';
import {dc, query, health} from './platform-upgrade-maintenance.fixture.mjs';

export async function rehearseMultinodeRecovery({config, fixture, evidence, marker, actors, approved, execute, assertActive, assertSource, stateOf, secretsOf}) {
  const nodes = await createMaintenanceMultinodeFixture(config, fixture);
  evidence.oldWorkerSource = nodes.oldWorkerSource;
  try {
    const first = actors(config, fixture, nodes.options), hash = await approved(first, config);
    evidence.activation = await assertActive(config, fixture, await execute(first, config, 'apply', hash), marker);
    const firstState = await stateOf(fixture), firstSaved = await secretsOf(fixture, firstState);
    evidence.firstRemote = await nodes.assertActive(firstState, firstSaved, {verifyOldIdentity: false});
    const nextVersion = config.newVersion.replace(/(\d+)$/, number => String(Number(number) + 1));
    const nextConfig = {...config, oldVersion: config.newVersion, newVersion: nextVersion, oldSchema: config.newSchema, resetRoleIdentity: false,
      versions: {[config.newVersion]: config.versions[config.newVersion], [nextVersion]: config.versions[config.newVersion]}};
    const next = actors(nextConfig, fixture, {...nodes.options, readyTimeoutMs: 1500}), nextHash = await approved(next, nextConfig);
    const start = next.startPreparing; let faultInjected = false;
    next.startPreparing = async state => {
      const receipt = await start(state), saved = await secretsOf(fixture, state);
      await nodes.assertPreparing(state);
      assert.equal(query(fixture, `SELECT rolcanlogin FROM pg_roles WHERE rolname='${saved.source.role}'`, {role: saved.admin.role, database: 'postgres'}), 'f');
      dc(fixture, ['stop', 'web']); faultInjected = true; return receipt;
    };
    await assert.rejects(next.lock(async () => {
      await next.archiveCompleted(await stateOf(fixture));
      return runMaintenanceUpgrade(next, {action: 'apply', target: nextVersion, approvedPlanHash: nextHash});
    }));
    assert.equal(faultInjected, true, 'must reach the real second-generation preparing fault');
    const rolled = await stateOf(fixture); assert.equal(rolled.status, 'rolled_back');
    const saved = await assertSource(nextConfig, fixture, rolled, marker);
    assert.equal(saved.admin.role, firstSaved.admin.role);
    assert.notEqual(saved.generation, firstSaved.generation);
    assert.equal(query(fixture, "SELECT claims_paused FROM global_settings WHERE id='global'", {role: saved.admin.role, database: saved.source.database}), 't');
    assert.equal(dc(fixture, ['ps', '--status', 'running', '-q', 'scheduler', 'web', 'image-admission']), '');
    await nodes.assertStopped(); evidence.pausedRemote = true;
    const resumed = await next.lock(() => next.resumeRollback(rolled)); assert.equal(resumed.status, 'rollback_resumed');
    await health(fixture, config.newVersion);
    const restored = await secretsOf(fixture, await stateOf(fixture)), identity = {role: restored.admin.role, database: restored.source.database};
    assert.equal(query(fixture, `SELECT rolcanlogin FROM pg_roles WHERE rolname='${restored.source.role}'`, identity), 'f');
    assert.equal(query(fixture, "SELECT claims_paused FROM global_settings WHERE id='global'", identity), 'f');
    evidence.recoveredRemote = await nodes.assertActive({...rolled, generation: restored.rollbackGeneration}, restored, {
      expectedVersion: config.newVersion, expectedSchema: config.newSchema, expectedDatabase: restored.source.database,
      expectedRuntimeRole: restored.rollbackRuntime.role, verifyOldIdentity: true,
    });
    evidence.secondGeneration = {sameDigests: true, schema: config.newSchema, fixtureVersion: nextVersion, faultInjected, status: 'rollback_resumed'};
  } finally {await nodes.close();}
}
