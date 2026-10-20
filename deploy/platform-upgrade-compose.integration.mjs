// Explicit opt-in real-container rehearsal. Does not build/publish images or use
// production deployments. Requires six prebuilt native immutable refs in JSON.
// node deploy/platform-upgrade-compose.integration.mjs --config refs.json --output /tmp/evidence
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgrade, assertDrained } from './platform-upgrade.mjs';
import { api, containerEvidence, createFixture, dc, docker, fixtureAdapter, imageKeys, inspectFixtureRef, loadFixtureConfig, sql, waitReady } from './platform-upgrade-compose.fixture.mjs';

const scriptPath = fileURLToPath(import.meta.url);
async function failureServer() {
  const server = createServer((_req, res) => { res.writeHead(503); res.end('intentional rehearsal outage'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}/`, close: async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }};
}

async function runInterruptedChild(descriptorPath) {
  const {configPath, fixture} = JSON.parse(await readFile(descriptorPath, 'utf8'));
  assert.match(fixture.project, /^pr747-upgrade-/);
  const config = await loadFixtureConfig(configPath);
  process.env.DEEPSONAR_ADMIN_TOKEN = fixture.token;
  const adapter = fixtureAdapter(config, fixture);
  // Crash after the state machine durably writes "stopping" and before the
  // actual stop. Every operation before the injection is the real host adapter.
  adapter.stop = async () => { process.kill(process.pid, 'SIGKILL'); };
  await upgrade('apply', adapter);
  throw new Error('crash injection unexpectedly returned');
}

export async function rehearse(configPath, output) {
  const config = await loadFixtureConfig(configPath);
  for (const key of ['DEEPSONAR_VERSION', ...Object.values(imageKeys), 'DEEPSONAR_IMAGE_TAG']) {
    assert.equal(process.env[key], undefined, `unset ${key} before isolated rehearsal`);
  }
  await mkdir(output, {recursive: true, mode: 0o700});
  const report = {startedAt: new Date().toISOString(), configPath, imageEvidence: [], cases: []};
  const previousToken = process.env.DEEPSONAR_ADMIN_TOKEN;
  try {
    for (const images of Object.values(config.versions)) for (const ref of Object.values(images)) {
      report.imageEvidence.push(await inspectFixtureRef(config, ref));
      docker(['pull', ref]);
    }
    await writeFile(join(output, 'image-evidence.json'), JSON.stringify(report.imageEvidence, null, 2), {mode: 0o600});

    async function scenario(name, run) {
      const fixture = await createFixture(config, output, name);
      assert.match(fixture.project, /^pr747-upgrade-/);
      process.env.DEEPSONAR_ADMIN_TOKEN = fixture.token;
      const evidence = {name, project: fixture.project, directory: fixture.directory};
      console.log(`[rehearsal] ${name}: starting isolated ${fixture.project}`);
      try {
        dc(fixture, ['up', '-d', '--wait', '--wait-timeout', '180']);
        evidence.initialHealth = await waitReady(fixture);
        evidence.before = containerEvidence(config, fixture, '0.0.1');
        await run(fixture, evidence);
        evidence.result = 'passed';
        console.log(`[rehearsal] ${name}: PASS`);
      } catch (error) {
        evidence.result = 'failed'; evidence.error = error.message;
        throw error;
      } finally {
        report.cases.push(evidence);
        try { await writeFile(join(fixture.directory, 'containers.log'), dc(fixture, ['logs', '--no-color']), {mode: 0o600}); }
        catch (error) { evidence.logError = error.message; }
        // Only the exact generated Compose project and its project-scoped volumes.
        try { dc(fixture, ['down', '--volumes', '--remove-orphans']); evidence.cleanedUp = true; }
        catch (error) { evidence.cleanupError = error.message; throw error; }
        await writeFile(join(fixture.directory, 'evidence.json'), JSON.stringify(evidence, null, 2), {mode: 0o600});
        await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2), {mode: 0o600});
      }
    }

    await scenario('success', async (fixture, evidence) => {
      const adapter = fixtureAdapter(config, fixture);
      const plan = await upgrade('check', adapter);
      assert.equal(plan.schemaRebuildRequired, false);
      assert.equal((await api(fixture, 'platform/claims')).claims_paused, false);
      const backupMarker = randomUUID();
      sql(fixture, `INSERT INTO projects (id, name) VALUES ('${backupMarker}', 'backup restore rehearsal marker')`);
      const state = await upgrade('apply', adapter);
      assert.equal(state.stage, 'complete');
      assert.equal((await api(fixture, 'platform/claims')).claims_paused, false);
      evidence.after = containerEvidence(config, fixture, '0.0.2');
      for (const name of Object.keys(evidence.before)) {
        assert.notEqual(evidence.before[name].container, evidence.after[name].container);
        assert.notEqual(evidence.before[name].imageId, evidence.after[name].imageId);
      }
      const dump = await adapter.verifyBackup(state.backup);
      // Restore into a separate database on this scenario's isolated PostgreSQL
      // volume. Never restore over the running deepsonar application database.
      const restoreDatabase = 'rehearsal_restore';
      dc(fixture, ['exec', '-T', 'postgres', 'createdb', '-U', 'deepsonar', '-O', 'deepsonar', restoreDatabase]);
      dc(fixture, ['exec', '-T', 'postgres', 'pg_restore', '-U', 'deepsonar', '-d', restoreDatabase, '--single-transaction', '--exit-on-error'], dump);
      const restored = JSON.parse(dc(fixture, ['exec', '-T', 'postgres', 'psql', '-U', 'deepsonar', '-d', restoreDatabase, '-v', 'ON_ERROR_STOP=1', '-Atc',
        `SELECT json_build_object(
          'schema', (SELECT version FROM schema_meta WHERE id='global'),
          'claims_paused', (SELECT claims_paused FROM global_settings WHERE id='global'),
          'markerCount', (SELECT count(*) FROM projects WHERE id='${backupMarker}'))`]));
      assert.deepEqual(restored, {schema: 59, claims_paused: true, markerCount: 1});
      assert.equal((await api(fixture, 'platform/claims')).claims_paused, false, 'restoring a separate database must not affect the upgraded application');
      evidence.restoreValidation = {database: restoreDatabase, markerId: backupMarker, ...restored};
      evidence.backup = state.backup;
      evidence.finalHealth = await api(fixture, 'health');
    });

    await scenario('rollback', async (fixture, evidence) => {
      const failedWeb = await failureServer();
      try {
        const adapter = fixtureAdapter(config, fixture, {webUrl: failedWeb.url});
        await assert.rejects(upgrade('apply', adapter), /external Web HTTP verification failed/);
      } finally { await failedWeb.close(); }
      assertDrained(await api(fixture, 'platform/claims'));
      evidence.upgradedBeforeFailure = containerEvidence(config, fixture, '0.0.2');
      const marker = randomUUID();
      sql(fixture, `INSERT INTO projects (id, name) VALUES ('${marker}', 'written while paused after backup')`);
      const state = await upgrade('rollback', fixtureAdapter(config, fixture));
      assert.equal(state.stage, 'rolled_back');
      assert.equal(sql(fixture, `SELECT count(*) FROM projects WHERE id='${marker}'`), '1');
      assertDrained(await api(fixture, 'platform/claims'));
      evidence.after = containerEvidence(config, fixture, '0.0.1');
      evidence.preservedWriteId = marker;
      evidence.finalClaims = await api(fixture, 'platform/claims');
    });

    await scenario('interrupted', async (fixture, evidence) => {
      const childConfig = join(fixture.directory, 'child.json');
      await writeFile(childConfig, JSON.stringify({configPath, fixture}), {mode: 0o600});
      const child = spawnSync(process.execPath, [scriptPath, '--interrupted-child', childConfig], {env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 600_000});
      await rm(childConfig);
      assert.equal(child.signal, 'SIGKILL', `child did not reach injected crash: ${String(child.stderr).slice(-2000)}`);
      const journal = JSON.parse(await readFile(join(fixture.directory, '.upgrade', 'state.json'), 'utf8'));
      assert.equal(journal.stage, 'stopping');
      assert.deepEqual(containerEvidence(config, fixture, '0.0.1'), evidence.before, 'pre-stop interruption must not restart services');
      assertDrained(await api(fixture, 'platform/claims'));
      // The exact child exited with SIGKILL; no upgrade process remains to own this lock.
      await rm(join(fixture.directory, '.upgrade', 'lock'), {recursive: true});
      const state = await upgrade('rollback', fixtureAdapter(config, fixture));
      assert.equal(state.stage, 'rolled_back');
      assertDrained(await api(fixture, 'platform/claims'));
      evidence.after = containerEvidence(config, fixture, '0.0.1');
      evidence.crashSignal = child.signal;
    });

    await scenario('drain-timeout', async (fixture, evidence) => {
      const project = randomUUID(), job = randomUUID();
      sql(fixture, `INSERT INTO projects (id,name) VALUES ('${project}','drain fixture');
        INSERT INTO jobs (id,project_id,type,status,agent_snapshot_json,lease_expires_at,started_at)
        VALUES ('${job}','${project}','explore','running','{}',now()+interval '1 hour',now());`);
      await assert.rejects(upgrade('apply', fixtureAdapter(config, fixture, {drainTimeoutMs: 1000})), /not safely paused/);
      const claims = await api(fixture, 'platform/claims');
      assert.equal(claims.claims_paused, true); assert.equal(claims.drained, false);
      assert.equal(sql(fixture, `SELECT status FROM jobs WHERE id='${job}'`), 'running');
      evidence.after = containerEvidence(config, fixture, '0.0.1');
      assert.deepEqual(evidence.after, evidence.before, 'drain timeout must not stop/restart any service');
      evidence.finalClaims = claims;
    });

    await scenario('cross-schema', async (fixture, evidence) => {
      // Both real builds use schema 59. Change the *observed database marker* to
      // exercise mismatch refusal; this is not a claim of a tested v58 upgrade.
      sql(fixture, "UPDATE schema_meta SET version=58 WHERE id='global'");
      await assert.rejects(upgrade('apply', fixtureAdapter(config, fixture)), /schema differs/);
      assert.equal((await api(fixture, 'platform/claims')).claims_paused, false);
      evidence.after = containerEvidence(config, fixture, '0.0.1');
      assert.deepEqual(evidence.after, evidence.before);
      evidence.observedSchema = 58; evidence.targetSchema = 59;
    });

    await scenario('remote-worker', async (fixture, evidence) => {
      sql(fixture, `INSERT INTO worker_nodes (id,endpoint,kind,api_key_fingerprint,node_token_hash,node_token_prefix)
        VALUES ('rehearsal-remote','127.0.0.1:1','remote','test','test','test')`);
      await assert.rejects(upgrade('apply', fixtureAdapter(config, fixture)), /remote workers require/);
      assert.equal((await api(fixture, 'platform/claims')).claims_paused, false);
      evidence.after = containerEvidence(config, fixture, '0.0.1');
      assert.deepEqual(evidence.after, evidence.before);
    });
    return report;
  } finally {
    if (previousToken === undefined) delete process.env.DEEPSONAR_ADMIN_TOKEN;
    else process.env.DEEPSONAR_ADMIN_TOKEN = previousToken;
    report.finishedAt = new Date().toISOString();
    await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2), {mode: 0o600});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    if (process.argv[2] === '--interrupted-child' && process.argv.length === 4) await runInterruptedChild(process.argv[3]);
    else {
      const args = process.argv.slice(2), options = {};
      for (let index = 0; index < args.length; index += 2) {
        assert.ok(['--config', '--output'].includes(args[index]) && args[index + 1], 'usage: --config refs.json --output /tmp/evidence');
        options[args[index]] = resolve(args[index + 1]);
      }
      assert.ok(options['--config'] && options['--output'], 'explicit fixture refs and output directory required');
      const report = await rehearse(options['--config'], options['--output']);
      console.log(`[rehearsal] ${report.cases.length} real Compose scenarios passed; evidence: ${options['--output']}`);
    }
  } catch (error) { console.error(`[rehearsal] ${error.message}`); process.exitCode = 1; }
}
