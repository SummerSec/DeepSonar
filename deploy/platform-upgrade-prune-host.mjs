import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readPrivateJson, durablePrivateWrite} from './platform-upgrade-filesystem.mjs';
import {planGenerationPrune, applyGenerationPrune} from './platform-upgrade-prune.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const literal = value => `E'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const ident = value => {
  if (!/^ds_upgrade_[a-f0-9]{32}(?:[a-f0-9]{8})?$/.test(value)) throw Error('PRUNE_DATABASE_NAME_INVALID');
  return `"${value}"`;
};
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const deployment = binding => ({root: binding.root, projectName: binding.projectName,
  postgresStorageHash: binding.postgresStorageHash, dockerIdentity: binding.dockerIdentity});

export const PRUNE_INVENTORY_SQL = `SELECT d.datname AS name,d.oid::text AS oid,
pg_database_size(d.oid)::float8 AS bytes,d.datistemplate AS template,r.rolname AS owner,
shobj_description(r.oid,'pg_authid') AS "ownerMarker",shobj_description(d.oid,'pg_database') AS marker,
(SELECT count(*)::int FROM pg_stat_activity s WHERE s.datid=d.oid) AS sessions,
((SELECT count(*) FROM pg_prepared_xacts x WHERE x.database=d.datname)+
 (SELECT count(*) FROM pg_replication_slots s WHERE s.database=d.datname)+
 (SELECT count(*) FROM pg_subscription s WHERE s.subdbid=d.oid))::int AS "references",
(SELECT coalesce(json_agg(json_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]'::json)
 FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a) AS acl
FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba ORDER BY d.datname`;
export const PRUNE_ROLES_SQL = `SELECT r.rolname AS name,r.rolcanlogin AS login,r.rolsuper AS superuser,
r.rolcreatedb AS createdb,r.rolcreaterole AS createrole,r.rolreplication AS replication,r.rolbypassrls AS bypassrls,
shobj_description(r.oid,'pg_authid') AS marker,
(SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships
FROM pg_roles r`;

/** Inspect even stopped containers, whose frozen environment survives a restart. */
export function collectRuntimeDatabaseReferences({dc, run, projectName, source}) {
  let ids, containers;
  try {
    ids = dc(['ps', '--all', '-q']).toString().trim().split(/\s+/).filter(Boolean);
    if (!ids.length || ids.length > 1000 || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw Error();
    containers = JSON.parse(run(['inspect', ...ids]).toString());
  } catch {throw Error('PRUNE_CONTAINER_REFERENCES_UNAVAILABLE');}
  if (!Array.isArray(containers) || containers.length !== ids.length) throw Error('PRUNE_CONTAINER_REFERENCES_UNAVAILABLE');
  const databases = new Set();
  for (const container of containers) {
    if (container.Config?.Labels?.['com.docker.compose.project'] !== projectName
        || !Array.isArray(container.Config?.Env)) throw Error('PRUNE_CONTAINER_BINDING_INVALID');
    const entries = container.Config.Env;
    for (const key of ['DATABASE_URL', 'DEEPSONAR_DATABASE_NAME']) {
      const values = entries.filter(entry => typeof entry === 'string' && entry.startsWith(`${key}=`));
      if (values.length > 1) throw Error('PRUNE_CONTAINER_DATABASE_AMBIGUOUS');
      if (!values.length) continue;
      let database = values[0].slice(key.length + 1);
      if (key === 'DATABASE_URL') {
        try {
          const url = new URL(database);
          if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== source.host
              || Number(url.port || 5432) !== source.port) throw Error();
          database = decodeURIComponent(url.pathname.slice(1));
        } catch {throw Error('PRUNE_CONTAINER_DATABASE_UNBOUND');}
      }
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw Error('PRUNE_CONTAINER_DATABASE_INVALID');
      databases.add(database);
    }
  }
  return [...databases].sort();
}

/** Uses only the upgrade host's bound Compose transport and independent admin. */
export async function runHostGenerationPrune({recovery, binding, source, runtimeDatabases, transport, apply = false, approvedPlanHash}) {
  const cluster = await readPrivateJson(resolve(recovery, 'cluster-admin.json'));
  if (!cluster?.admin || !/^\d+$/.test(cluster.clusterId) || !new RegExp(`^${uuid}$`).test(cluster.operationId)) throw Error('PRUNE_CLUSTER_AUTHORITY_MISSING');
  const current = await source();
  const connection = {image: current.values.DEEPSONAR_SCHEDULER_IMAGE, ...cluster.admin, port: current.port};
  const rows = (database, sql) => transport.rows({...connection, database, sql});
  const scalar = async (database, sql) => Object.values((await rows(database, sql))[0] ?? {})[0];
  const currentBinding = hash(deployment(await binding()));
  const loadOperations = async () => {
    const names = await readdir(recovery), operations = [];
    const legacy = await readPrivateJson(resolve(recovery, 'state.json'));
    if (legacy && !['complete', 'rolled_back'].includes(legacy.stage)) throw Error('PRUNE_LEGACY_RECOVERY_PENDING');
    const journalNames = names.filter(name => name === 'maintenance.json' || new RegExp(`^maintenance-${uuid}\\.completed\\.json$`).test(name));
    const seen = new Set();
    for (const name of journalNames) {
      const state = await readPrivateJson(resolve(recovery, name));
      if (state?.schema !== 'deepsonar.maintenance-upgrade/v1' || !new RegExp(`^${uuid}$`).test(state.generation)
          || !state.binding || !state.receipts || hash(deployment(state.binding)) !== currentBinding) throw Error('PRUNE_JOURNAL_BINDING_INVALID');
      const saved = await readPrivateJson(resolve(recovery, `identity-${state.generation}.json`));
      if (!saved || saved.generation !== state.generation || saved.bindingHash !== hash(state.binding)
          || saved.clusterId !== cluster.clusterId || !saved.source?.database || !saved.candidateDatabase) throw Error('PRUNE_IDENTITY_BINDING_INVALID');
      seen.add(state.generation);
      const backup = state.receipts.backup, candidate = state.receipts.candidate;
      const operationId = state.generation.replaceAll('-', '');
      const ownedReceipt = backup?.operation_id === operationId && backup.source_database === saved.source.database
        && backup.fence_epoch === state.generation && candidate?.operation_id === operationId
        && candidate.database === saved.candidateDatabase && candidate.backup_sha256 === backup.sha256
        && candidate.fence_epoch === state.generation;
      operations.push({generation: state.generation, status: state.status, archived: name !== 'maintenance.json',
        source: saved.source.database, candidate: saved.candidateDatabase, cluster: saved.clusterId,
        backup: ownedReceipt ? backup.sha256 : undefined, runtime: saved.runtime?.role, rollbackRuntime: saved.rollbackRuntime?.role});
    }
    // An identity left without a journal is a recovery obligation, never delete authority.
    for (const name of names.filter(name => new RegExp(`^identity-${uuid}\\.json$`).test(name))) {
      const generation = name.slice(9, -5);
      if (seen.has(generation)) continue;
      const saved = await readPrivateJson(resolve(recovery, name));
      if (saved?.generation !== generation || saved.clusterId !== cluster.clusterId || !saved.source?.database || !saved.candidateDatabase) throw Error('PRUNE_ORPHAN_IDENTITY_INVALID');
      operations.push({generation, status: 'orphan', source: saved.source.database, candidate: saved.candidateDatabase});
    }
    return operations;
  };
  const snapshot = async () => {
    if (hash(deployment(await binding())) !== currentBinding || (await source()).database !== current.database) throw Error('PRUNE_DEPLOYMENT_CHANGED');
    const actualCluster = await scalar('postgres', 'SELECT system_identifier::text FROM pg_control_system()');
    if (actualCluster !== cluster.clusterId) throw Error('PRUNE_CLUSTER_IDENTITY_CHANGED');
    const roles = await rows('postgres', PRUNE_ROLES_SQL);
    const admin = roles.find(role => role.name === cluster.admin.role);
    if (!admin?.superuser || !admin.login || admin.marker !== `deepsonar-upgrade:${cluster.operationId}` || admin.memberships !== 0) throw Error('PRUNE_ADMIN_IDENTITY_CHANGED');
    // Any other live superuser can bypass the retirement fence.
    if (roles.some(role => role.name !== admin.name && role.login && (role.superuser || role.createdb || role.createrole || role.replication))) throw Error('PRUNE_UNKNOWN_PRIVILEGED_LOGIN');
    const operations = await loadOperations();
    const databases = await rows('postgres', PRUNE_INVENTORY_SQL);
    for (const database of databases) {
      if (!/^ds_upgrade_[a-f0-9]{32}(?:[a-f0-9]{8})?$/.test(database.name) || database.sessions !== 0) continue;
      try {
        const state = await rows(database.name, "SELECT phase,generation,runtime_role FROM platform_upgrade_state WHERE id='global'");
        database.runtimeState = state.length === 1 ? state[0] : null;
      } catch {database.runtimeState = null;}
    }
    const containerReferences = await runtimeDatabases();
    return {cluster: actualCluster, binding: currentBinding, current: current.database, databases, operations, roles,
      runtimeDatabases: containerReferences,
      admin: {role: admin.name, marker: admin.marker}};
  };
  const planPath = resolve(recovery, 'generation-prune-plan.json');
  if (!apply) {
    const previous = await readPrivateJson(planPath);
    for (const candidate of previous?.candidates ?? []) {
      if (!/^[a-f0-9]{64}$/.test(previous.plan_hash) || !/^\d+$/.test(candidate.oid)) throw Error('PRUNE_PLAN_INVALID');
      const receipt = await readPrivateJson(resolve(recovery, `generation-prune-${previous.plan_hash}-${candidate.oid}.json`));
      if (receipt && receipt.phase !== 'dropped') throw Error('PRUNE_PLAN_RECOVERY_REQUIRED');
    }
    const plan = planGenerationPrune(await snapshot());
    await durablePrivateWrite(planPath, JSON.stringify(plan));
    return {...plan, dry_run: true};
  }
  const plan = await readPrivateJson(planPath);
  if (!plan || !/^[a-f0-9]{64}$/.test(approvedPlanHash ?? '') || plan.plan_hash !== approvedPlanHash) throw Error('PRUNE_PLAN_APPROVAL_REQUIRED');
  const receiptPath = candidate => resolve(recovery, `generation-prune-${plan.plan_hash}-${candidate.oid}.json`);
  return applyGenerationPrune({snapshot,
    readReceipt: candidate => readPrivateJson(receiptPath(candidate)),
    writeReceipt: receipt => durablePrivateWrite(receiptPath(receipt), JSON.stringify(receipt)),
    audit: async (_snapshot, receipt) => {
      const payload = {cluster: receipt.cluster, database: receipt.name, oid: receipt.oid, operation: receipt.operation,
        plan_hash: receipt.plan_hash, estimated_bytes: receipt.bytes, phase: receipt.phase};
      const action = receipt.phase === 'intent' ? 'platform_upgrade.generation_prune_intent' : 'platform_upgrade.generation_pruned';
      await rows(current.database, `INSERT INTO audit_logs(actor_type,actor_id,action,resource_type,resource_id,request_id,after_json)
SELECT 'system','platform_upgrade_host',${literal(action)},'database',${literal(receipt.name)},${literal(plan.plan_hash)},${literal(JSON.stringify(payload))}::jsonb
WHERE NOT EXISTS(SELECT 1 FROM audit_logs WHERE actor_type='system' AND actor_id='platform_upgrade_host' AND action=${literal(action)} AND resource_id=${literal(receipt.name)} AND request_id=${literal(plan.plan_hash)});`);
    },
    drop: async candidate => {
      // No FORCE and no session termination. PostgreSQL refuses any raced connection.
      // The shared upgrade lock and exclusive privileged identity serialize managed DDL.
      const actual = await rows('postgres', `SELECT oid::text FROM pg_database WHERE datname=${literal(candidate.name)}`);
      if (actual.length !== 1 || actual[0].oid !== candidate.oid) throw Error('PRUNE_DATABASE_IDENTITY_CHANGED');
      await rows('postgres', `DROP DATABASE ${ident(candidate.name)}`);
    },
  }, plan);
}
