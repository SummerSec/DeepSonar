import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), {code});
const candidateName = /^ds_upgrade_[a-f0-9]{32}(?:[a-f0-9]{8})?$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const parse = text => {try {return JSON.parse(text);} catch {return null;}};

/** Historical records prove ownership. Only current recovery obligations retain sources. */
export function planGenerationPrune(snapshot) {
  const {current, operations, databases, roles, admin} = snapshot;
  if (!/^\d+$/.test(snapshot.cluster) || !/^[a-f0-9]{64}$/.test(snapshot.binding)
      || !/^[a-z][a-z0-9_]{0,62}$/.test(current) || !Array.isArray(operations)
      || !Array.isArray(databases) || !Array.isArray(roles) || !admin?.marker || !Array.isArray(snapshot.runtimeDatabases)
      || snapshot.runtimeDatabases.some(database => !/^[a-z][a-z0-9_]{0,62}$/.test(database))) throw fail('PRUNE_INVENTORY_INVALID');
  const retained = [], candidates = [], references = new Set([current, ...snapshot.runtimeDatabases]);
  const active = operations.filter(operation => !operation.archived && operation.status === 'complete' && operation.candidate === current);
  // No authoritative completed current journal means no historical delete authority.
  const authority = active.length === 1;
  if (authority) references.add(active[0].source);
  for (const operation of operations) {
    if (!['complete', 'rollback_resumed'].includes(operation.status)) {
      references.add(operation.source); references.add(operation.candidate);
    }
  }
  for (const row of databases) {
    let reason = row.name === current ? 'CURRENT_DATABASE' : references.has(row.name) ? 'RECOVERY_REFERENCE' : null;
    const marker = parse(row.marker);
    const operation = operations.find(value => value.candidate === row.name && uuid.test(value.generation)
      && value.cluster === snapshot.cluster && marker?.operation_id === value.generation.replaceAll('-', '')
      && marker.source_database === value.source && marker.backup_sha256 === value.backup && /^[a-f0-9]{64}$/.test(value.backup));
    const allowedRoles = operation ? new Set([operation.runtime, operation.rollbackRuntime]) : new Set();
    const roleSafe = name => roles.some(role => role.name === name && role.login === false && role.memberships === 0
      && role.superuser === false && role.createdb === false && role.createrole === false && role.replication === false
      && role.bypassrls === false
      && role.marker?.replace(/:revoked$/, '') === `deepsonar-upgrade:${operation.generation}:runtime:${row.name}`);
    const aclSafe = Array.isArray(row.acl) && row.acl.every(acl => acl.grantor === admin.role && (acl.role === admin.role
      || (acl.role === 'PUBLIC' && acl.privilege === 'TEMPORARY' && acl.grantable === false)
      || (allowedRoles.has(acl.role) && acl.privilege === 'CONNECT' && acl.grantable === false && roleSafe(acl.role))));
    const runtime = row.runtimeState;
    if (!reason && (!authority || !candidateName.test(row.name) || !operation || marker.phase !== 'rebuilt'
        || row.template !== false || row.owner !== admin.role || row.ownerMarker !== admin.marker
        || !/^\d+$/.test(row.oid) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
        || row.sessions !== 0 || row.references !== 0 || !aclSafe
        || !runtime || !['active', 'preparing'].includes(runtime.phase) || runtime.generation !== operation.generation
        || runtime.runtime_role !== operation.runtime || !roleSafe(operation.runtime))) reason = 'OWNERSHIP_OR_ACTIVITY_UNPROVEN';
    if (reason) retained.push({name: row.name, oid: row.oid, bytes: row.bytes, reason});
    else candidates.push({name: row.name, oid: row.oid, bytes: row.bytes, operation: operation.generation,
      marker_hash: hash(row.marker), owner: row.owner});
  }
  const plan = {schema: 'deepsonar.generation-prune/v1', cluster: snapshot.cluster, binding: snapshot.binding, current,
    candidates, retained, reclaimable_bytes: candidates.reduce((sum, row) => sum + row.bytes, 0)};
  return {...plan, plan_hash: hash(plan)};
}

/** The caller holds the same OS lock as upgrade for the whole operation. */
export async function applyGenerationPrune(io, plan) {
  const {plan_hash: approvedHash, ...body} = plan;
  if (plan.schema !== 'deepsonar.generation-prune/v1' || hash(body) !== approvedHash) throw fail('PRUNE_PLAN_INVALID');
  const dropped = [];
  for (const candidate of plan.candidates) {
    if (!candidateName.test(candidate.name) || !/^\d+$/.test(candidate.oid)
        || !uuid.test(candidate.operation) || !/^[a-f0-9]{64}$/.test(candidate.marker_hash)) throw fail('PRUNE_PLAN_INVALID');
    let receipt = await io.readReceipt(candidate);
    const verify = async () => {
      const snapshot = await io.snapshot();
      if (snapshot.cluster !== plan.cluster || snapshot.binding !== plan.binding || snapshot.current !== plan.current) throw fail('PRUNE_DEPLOYMENT_CHANGED');
      const actual = snapshot.databases.find(row => row.name === candidate.name);
      if (actual && actual.oid !== candidate.oid) throw fail('PRUNE_DATABASE_IDENTITY_CHANGED');
      if (!actual) {
        if (!receipt || !['dropping', 'dropped'].includes(receipt.phase)) throw fail('PRUNE_DATABASE_ABSENCE_UNPROVEN');
        return null;
      }
      const eligible = planGenerationPrune(snapshot).candidates.find(row => row.name === candidate.name);
      if (!eligible || eligible.oid !== candidate.oid || eligible.marker_hash !== candidate.marker_hash || eligible.owner !== candidate.owner) throw fail('PRUNE_ELIGIBILITY_CHANGED');
      return snapshot;
    };
    if (receipt && (receipt.cluster !== plan.cluster || receipt.oid !== candidate.oid || receipt.name !== candidate.name
        || receipt.plan_hash !== approvedHash)) throw fail('PRUNE_RECEIPT_MISMATCH');
    const snapshot = await verify();
    if (snapshot) {
      if (receipt?.phase === 'dropped') throw fail('PRUNE_DATABASE_IDENTITY_CHANGED');
      receipt = {...candidate, cluster: plan.cluster, plan_hash: approvedHash, phase: 'intent'};
      await io.writeReceipt(receipt);
      await io.audit(snapshot, receipt);
      await verify();
      receipt = {...receipt, phase: 'dropping'};
      await io.writeReceipt(receipt);
      try {await io.drop(candidate);} catch {throw fail('PRUNE_DROP_UNCERTAIN');}
      if (await verify()) throw fail('PRUNE_DROP_UNCERTAIN');
    }
    receipt = {...receipt, phase: 'dropped'};
    await io.audit(await io.snapshot(), receipt);
    await io.writeReceipt(receipt);
    dropped.push({...candidate, reconciled: !snapshot});
  }
  return {schema: plan.schema, plan_hash: approvedHash, dropped};
}
