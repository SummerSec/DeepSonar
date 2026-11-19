import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {collectRuntimeDatabaseReferences} from './platform-upgrade-prune-host.mjs';
import {planGenerationPrune, applyGenerationPrune} from './platform-upgrade-prune.mjs';

const generation = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const database = digit => `ds_upgrade_${generation(digit).replaceAll('-', '')}`;
export function pruneFixture() {
  const operations = ['1', '2', '3'].map((digit, index) => ({generation: generation(digit), status: 'complete', archived: index < 2,
    source: index === 0 ? 'deepsonar' : database(String(index)), candidate: database(digit), cluster: '123',
    backup: 'a'.repeat(64), runtime: `runtime_${digit}`, rollbackRuntime: `rollback_${digit}`}));
  return {cluster: '123', binding: 'b'.repeat(64), current: database('3'), runtimeDatabases: [database('3')], operations,
    databases: operations.map((operation, index) => ({name: operation.candidate, oid: String(100 + index), bytes: 1024,
      owner: 'maintenance', ownerMarker: 'deepsonar-upgrade:admin-operation', sessions: 0, references: 0, template: false,
      marker: JSON.stringify({operation_id: operation.generation.replaceAll('-', ''), source_database: operation.source,
        backup_sha256: operation.backup, phase: 'rebuilt'}),
      acl: [{role: 'maintenance', grantor: 'maintenance', privilege: 'CONNECT', grantable: false}, {role: 'runtime_1', grantor: 'maintenance', privilege: 'CONNECT', grantable: false}],
      runtimeState: {phase: 'active', generation: operation.generation, runtime_role: operation.runtime}})),
    admin: {role: 'maintenance', marker: 'deepsonar-upgrade:admin-operation'},
    roles: operations.flatMap(operation => [operation.runtime, operation.rollbackRuntime].map(name => ({name, login: false,
      memberships: 0, superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false,
      marker: `deepsonar-upgrade:${operation.generation}:runtime:${operation.candidate}`})))};
}

test('retains current and its completed source, without retaining every archived source', () => {
  const snapshot = pruneFixture(), plan = planGenerationPrune(snapshot);
  assert.deepEqual(plan.candidates.map(row => row.name), [database('1')]);
  assert.equal(plan.reclaimable_bytes, 1024);
  assert.equal(plan.retained.find(row => row.name === database('2')).reason, 'RECOVERY_REFERENCE');
  assert.equal(plan.retained.find(row => row.name === database('3')).reason, 'CURRENT_DATABASE');
  snapshot.databases[0].name += '00000001';
  snapshot.operations[0].candidate += '00000001';
  for (const role of snapshot.roles.slice(0, 2)) role.marker += '00000001';
  assert.equal(planGenerationPrune(snapshot).candidates.length, 1);
});

test('unknown ownership, ACL, active sessions, references and unsafe names are retained', () => {
  const changes = [row => {row.ownerMarker = 'unknown';}, row => {row.sessions = 1;}, row => {row.references = 1;},
    row => {row.marker = '{}';}, row => {row.name = 'deepsonar_restore';}, row => {row.name += 'a';},
    row => {row.acl.push({role: 'unknown', privilege: 'CONNECT'});}, row => {row.template = true;},
    row => {row.runtimeState = null;}, row => {row.runtimeState.generation = generation('9');}];
  for (const change of changes) {
    const snapshot = pruneFixture(); change(snapshot.databases[0]);
    assert.equal(planGenerationPrune(snapshot).candidates.length, 0);
  }
  for (const field of ['login', 'memberships']) {
    const snapshot = pruneFixture(); snapshot.roles[0][field] = field === 'login' ? true : 1;
    assert.equal(planGenerationPrune(snapshot).candidates.length, 0);
  }
});

test('unfinished and orphan operations protect both source and candidate', () => {
  for (const status of ['preparing', 'rolling_back', 'rollback_resuming', 'active_repair', 'unknown']) {
    const snapshot = pruneFixture(); snapshot.operations.push({...snapshot.operations[1], status, source: database('1')});
    assert.equal(planGenerationPrune(snapshot).candidates.length, 0);
  }
  const snapshot = pruneFixture(); snapshot.operations[2].status = 'rollback_resumed';
  snapshot.current = snapshot.operations[2].source;
  assert.equal(planGenerationPrune(snapshot).retained.some(row => row.name === snapshot.current), true);
});

test('configured current D with container referencing A and no sessions retains A', () => {
  const snapshot = pruneFixture();
  snapshot.runtimeDatabases.push(database('1'));
  assert.equal(snapshot.databases[0].sessions, 0);
  const plan = planGenerationPrune(snapshot);
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.retained.find(row => row.name === database('1')).reason, 'RECOVERY_REFERENCE');
});

// Collection + pure planning only: no transport, SQL, apply or database deletion.
test('official backup PGDATABASE protects a zero-session generation even when stopped', () => {
  const compose = readFileSync(new URL('./docker-compose.prod.yml', import.meta.url), 'utf8');
  const backup = compose.split('\n  backup:')[1].split('\n  silo:')[0];
  assert.match(backup, /PGDATABASE: \$\{DEEPSONAR_DATABASE_NAME:-deepsonar\}/);
  assert.match(backup, /pg_dump -h postgres/);
  const snapshot = pruneFixture();
  assert.equal(planGenerationPrune(snapshot).candidates.length, 1, 'fixture is otherwise eligible');
  const id = 'a'.repeat(64);
  for (const status of ['running', 'exited']) {
    const container = {State: {Status: status}, Config: {
      Labels: {'com.docker.compose.project': 'fixture', 'com.docker.compose.service': 'backup'},
      Env: ['PGPASSWORD=synthetic', 'PGUSER=deepsonar', `PGDATABASE=${database('1')}`]}};
    const references = () => collectRuntimeDatabaseReferences({projectName: 'fixture',
      source: {host: 'postgres', port: 5432},
      dc: args => {assert.deepEqual(args, ['ps', '--all', '-q']); return Buffer.from(id);},
      run: args => {assert.deepEqual(args, ['inspect', id]); return Buffer.from(JSON.stringify([container]));}});
    assert.deepEqual(references(), [database('1')]);
    const plan = planGenerationPrune({...snapshot, runtimeDatabases: references()});
    assert.equal(snapshot.databases[0].sessions, 0);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.retained.find(row => row.name === database('1')).reason, 'RECOVERY_REFERENCE');
    container.Config.Env.push('PGDATABASE=another');
    assert.throws(references, /PRUNE_CONTAINER_DATABASE_AMBIGUOUS/);
    container.Config.Env = ['PGDATABASE='];
    assert.throws(references, /PRUNE_CONTAINER_DATABASE_INVALID/);
  }
});

function executor(snapshot) {
  let receipt = null;
  const events = [];
  return {events, receipt: () => receipt, io: {
    snapshot: async () => structuredClone(snapshot), readReceipt: async () => receipt,
    writeReceipt: async value => {receipt = structuredClone(value); events.push(value.phase);},
    audit: async (_snapshot, value) => {events.push(`audit:${value.phase}`);},
    drop: async row => {events.push('drop'); snapshot.databases = snapshot.databases.filter(value => value.oid !== row.oid);},
  }};
}

test('intent and durable host receipt precede DROP, then absence is audited', async () => {
  const snapshot = pruneFixture(), plan = planGenerationPrune(snapshot), f = executor(snapshot);
  const result = await applyGenerationPrune(f.io, plan);
  assert.equal(result.dropped.length, 1);
  assert.deepEqual(f.events, ['intent', 'audit:intent', 'dropping', 'drop', 'audit:dropped', 'dropped']);
});

test('failed final audit retains dropping receipt until original plan completes the audit', async () => {
  const snapshot = pruneFixture(), plan = planGenerationPrune(snapshot), f = executor(snapshot);
  const audit = f.io.audit;
  f.io.audit = async (state, receipt) => {
    if (receipt.phase === 'dropped') throw Error('fixture final audit unavailable');
    await audit(state, receipt);
  };
  await assert.rejects(applyGenerationPrune(f.io, plan), /fixture final audit unavailable/);
  assert.equal(f.receipt().phase, 'dropping');
  f.io.audit = audit;
  const result = await applyGenerationPrune(f.io, plan);
  assert.equal(result.dropped[0].reconciled, true);
  assert.equal(f.receipt().phase, 'dropped');
  assert.equal(f.events.filter(event => event === 'drop').length, 1);
});

test('lost DROP response reconciles absence and refuses a same-name replacement OID', async () => {
  const snapshot = pruneFixture(), plan = planGenerationPrune(snapshot), f = executor(snapshot);
  const drop = f.io.drop;
  f.io.drop = async row => {await drop(row); throw Error('lost response');};
  await assert.rejects(applyGenerationPrune(f.io, plan), /PRUNE_DROP_UNCERTAIN/);
  assert.equal(f.receipt().phase, 'dropping');
  const original = structuredClone(pruneFixture().databases[0]);
  snapshot.databases.push({...original, oid: '999'});
  await assert.rejects(applyGenerationPrune(f.io, plan), /PRUNE_DATABASE_IDENTITY_CHANGED/);
  snapshot.databases.pop();
  const result = await applyGenerationPrune(f.io, plan);
  assert.equal(result.dropped[0].reconciled, true);
  assert.equal(f.events.filter(event => event === 'drop').length, 1);
});

test('changed cluster, recovery refs or ownership between plan and apply prevent DROP', async () => {
  for (const change of [s => {s.cluster = '456';}, s => {s.current = database('1');},
    s => {s.databases[0].oid = '777';}, s => {s.databases[0].sessions = 1;}]) {
    const snapshot = pruneFixture(), plan = planGenerationPrune(snapshot), f = executor(snapshot);
    change(snapshot);
    await assert.rejects(applyGenerationPrune(f.io, plan), /PRUNE_/);
    assert.equal(f.events.includes('drop'), false);
  }
});
