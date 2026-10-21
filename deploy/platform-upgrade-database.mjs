// PostgreSQL role fence. Credentials belong to the caller's durable secure store.
// runSql receives SQL on stdin and credentials out of argv; it must return JSON.
import { randomBytes } from 'node:crypto';

export function databaseIdentity(prefix = 'ds_upgrade') {
  if (!/^[a-z][a-z0-9_]{0,25}$/.test(prefix)) throw new Error('invalid identity prefix');
  return {role: `${prefix}_${randomBytes(12).toString('hex')}`, password: randomBytes(32).toString('hex')};
}
const ident = value => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('invalid database role');
  return `"${value}"`;
};
const literal = value => `E'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const parse = value => typeof value === 'string' || Buffer.isBuffer(value) ? JSON.parse(value.toString().trim()) : value;

export function createDatabaseFence({runSql, runtimeRole, bootstrapPassword, admin, operationId, adminOperationId = operationId, expectedClusterSystemIdentifier,
  runtimeIdentities = [], dedicatedDatabases = [], timeoutMs = 10_000, pollMs = 100}) {
  ident(runtimeRole); ident(admin.role);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 1000) throw new Error('invalid bounded fence timeout');
  if (runtimeRole === admin.role || !/^[a-zA-Z0-9_-]{8,100}$/.test(operationId)) throw new Error('invalid fence identity');
  if (!admin.password || admin.password.length < 32) throw new Error('maintenance credential must be generated and persisted first');
  for (const database of dedicatedDatabases) { ident(database); if (['postgres', 'template0', 'template1'].includes(database)) throw new Error('system database cannot be a dedicated business scope'); }
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(adminOperationId)) throw new Error('invalid admin operation identity');
  if (adminOperationId !== operationId && !/^[0-9]+$/.test(expectedClusterSystemIdentifier ?? '')) throw new Error('reused administrator requires cluster identity binding');
  const marker = `deepsonar-upgrade:${operationId}`;
  const adminMarker = `deepsonar-upgrade:${adminOperationId}`;
  const generated = new Set(runtimeIdentities.map(value => { ident(value); return value; }));
  const known = new Set([runtimeRole, admin.role, ...generated]);
  const execute = async (identity, sql) => {
    try { return parse(await runSql({database: 'postgres', ...identity, sql})); }
    catch { throw new Error('database fence command failed; credentials and SQL suppressed'); }
  };
  const adminSql = sql => execute(admin, sql);
  // PostgreSQL's launcher uses bootstrap OID 10 and restarts even when NOLOGIN.
  // It cannot dispatch any workers when the shared subscription catalog is empty.
  const retiredSessions = `usename=${literal(runtimeRole)} AND backend_type <> 'logical replication launcher'`;
  const rolesSql = `SELECT coalesce(json_agg(json_build_object('oid',oid,'name',rolname,'login',rolcanlogin,'inherit',rolinherit,'superuser',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypassrls',rolbypassrls,'marker',shobj_description(oid,'pg_authid'))), '[]'::json) FROM pg_roles;`;
  function validate(rows) {
    const unexpected = rows.filter(row => row.login && !known.has(row.name));
    if (unexpected.length) throw new Error('unknown login database roles; dedicated cluster inspection required');
    const owner = rows.find(row => row.name === runtimeRole);
    if (!owner) throw new Error('runtime owner role missing');
    for (const row of rows.filter(row => known.has(row.name) && row.name !== runtimeRole)) {
      if (generated.has(row.name) && (row.superuser || row.createdb || row.createrole || row.replication || row.bypassrls || row.inherit)) throw new Error('generated runtime identity gained unsafe privileges');
      if (row.marker !== (row.name === admin.role ? adminMarker : marker) && !(generated.has(row.name) && row.marker?.startsWith(`${marker}:runtime:`))) throw new Error('database identity is not owned by this upgrade');
    }
    return rows;
  }
  const clusterIdentity = async () => {
    const {id: value} = await adminSql("SELECT json_build_object('id',system_identifier::text) FROM pg_control_system();");
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new Error('invalid cluster identity');
    if (expectedClusterSystemIdentifier && value !== expectedClusterSystemIdentifier) throw new Error('maintenance cluster identity mismatch');
    return value;
  };
  const inspect = async () => {
    await clusterIdentity();
    const rows = validate(await adminSql(rolesSql));
    if (await adminSql('SELECT count(*)::int FROM pg_subscription;') !== 0) throw new Error('logical subscriptions require operator reconciliation');
    return rows;
  };
  async function bootstrap() {
    let ready;
    try { ready = await adminSql(rolesSql); } catch { /* New administrator may not exist yet. */ }
    if (ready) {
      validate(ready);
      const row = ready.find(value => value.name === admin.role);
      if (!row?.login || !row.superuser) throw new Error('maintenance administrator is not usable');
      return {operationId, adminOperationId, clusterSystemIdentifier: await clusterIdentity(), adminRole: admin.role, stage: 'administrator_ready'};
    }
    const initial = {role: runtimeRole, password: bootstrapPassword};
    const rows = validate(await execute(initial, rolesSql));
    const owner = rows.find(row => row.name === runtimeRole);
    if (!owner.superuser) throw new Error('bootstrap requires the current runtime superuser');
    const existing = rows.find(row => row.name === admin.role);
    if (!existing) {
      await execute(initial, `BEGIN; CREATE ROLE ${ident(admin.role)} LOGIN SUPERUSER PASSWORD ${literal(admin.password)}; COMMENT ON ROLE ${ident(admin.role)} IS ${literal(adminMarker)}; COMMIT; SELECT to_json(true);`);
    }
    const checked = await inspect();
    const maintenance = checked.find(row => row.name === admin.role);
    if (!maintenance?.login || !maintenance.superuser) throw new Error('maintenance administrator is not usable');
    return {operationId, adminOperationId, clusterSystemIdentifier: await clusterIdentity(), adminRole: admin.role, stage: 'administrator_ready'};
  }
  async function verify() {
    const rows = await inspect();
    const owner = rows.find(row => row.name === runtimeRole);
    if (owner.login || (owner.superuser && Number(owner.oid) !== 10) || owner.createdb || owner.createrole || owner.replication || owner.bypassrls) throw new Error('old runtime identity is not fenced');
    const deadline = Date.now() + timeoutMs;
    while (await adminSql(`SELECT count(*)::int FROM pg_stat_activity WHERE ${retiredSessions};`) !== 0) {
      if (Date.now() >= deadline) throw new Error('old runtime sessions remain');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    const prepared = await adminSql('SELECT count(*)::int FROM pg_prepared_xacts;');
    if (prepared !== 0) throw new Error('prepared transactions require operator reconciliation');
    const identity = await adminSql(`SELECT json_build_object('runtimeRoleOid',(SELECT oid FROM pg_roles WHERE rolname=${literal(runtimeRole)}),'clusterSystemIdentifier',(SELECT system_identifier::text FROM pg_control_system()));`);
    return {operationId, epoch: operationId, runtimeRole, bootstrapSuperuserRetained: Number(owner.oid) === 10 && owner.superuser, adminRole: admin.role, ...identity, stage: 'fenced'};
  }
  async function fence() {
    const roles = await inspect();
    const bootstrapOwner = Number(roles.find(role => role.name === runtimeRole).oid) === 10;
    await adminSql(`BEGIN; ALTER ROLE ${ident(runtimeRole)} NOLOGIN ${bootstrapOwner ? '' : 'NOSUPERUSER'} NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; COMMIT; SELECT to_json(true);`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await adminSql(`SELECT coalesce(json_agg(pg_terminate_backend(pid)), '[]'::json) FROM pg_stat_activity WHERE ${retiredSessions} AND pid <> pg_backend_pid();`);
      const count = await adminSql(`SELECT count(*)::int FROM pg_stat_activity WHERE ${retiredSessions};`);
      if (count === 0) return verify();
      if (Date.now() >= deadline) throw new Error('old runtime sessions did not terminate; fence remains closed');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  async function createRuntime(identity) {
    ident(identity.role); ident(identity.database);
    if (!dedicatedDatabases.includes(identity.database)) throw new Error('explicit dedicated database scope required');
    if (known.has(identity.role) && !generated.has(identity.role)) throw new Error('reserved database identity');
    if (!identity.password || identity.password.length < 32) throw new Error('runtime credential must be persisted first');
    await verify();
    known.add(identity.role); generated.add(identity.role);
    const roleMarker = `${marker}:runtime:${identity.database}`;
    const rows = await inspect(), existing = rows.find(row => row.name === identity.role);
    if (!existing) {
      await adminSql(`BEGIN; CREATE ROLE ${ident(identity.role)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(identity.password)}; COMMENT ON ROLE ${ident(identity.role)} IS ${literal(roleMarker)}; COMMIT; SELECT to_json(true);`);
    } else if (existing.marker !== roleMarker || existing.superuser || existing.createdb || existing.createrole || existing.replication || existing.bypassrls) {
      throw new Error('runtime identity attributes mismatch or revoked');
    }
    const memberships = await adminSql(`SELECT count(*)::int FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=${literal(identity.role)});`);
    if (memberships !== 0) throw new Error('runtime identity must not inherit or SET ROLE to an owner');
    const databaseSql = sql => execute({...admin, database: identity.database}, sql);
    // Explicit dedicated scope permits removing the rebuild helper's PUBLIC CREATE grant.
    await databaseSql('REVOKE CREATE ON SCHEMA public FROM PUBLIC; SELECT to_json(true);');
    const canCreate = await databaseSql(`SELECT to_json(has_schema_privilege(${literal(identity.role)}, 'public', 'CREATE'));`);
    if (canCreate) throw new Error('runtime would inherit schema CREATE; maintenance must restrict PUBLIC privileges');
    await databaseSql(`BEGIN; GRANT CONNECT ON DATABASE ${ident(identity.database)} TO ${ident(identity.role)}; GRANT USAGE ON SCHEMA public TO ${ident(identity.role)}; GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ident(identity.role)}; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ident(identity.role)}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ident(identity.role)}; ALTER ROLE ${ident(identity.role)} LOGIN; COMMIT; SELECT to_json(true);`);
    return {operationId, role: identity.role, database: identity.database, privilegesChanged: ['public_schema_create_revoked_from_public', 'runtime_dml_granted'], stage: 'runtime_ready'};
  }
  async function suspendRuntime(role, {database, generation} = {}) {
    ident(role); ident(database);
    if (generation !== operationId || !dedicatedDatabases.includes(database) || !generated.has(role)) throw new Error('invalid preparing runtime scope');
    const rows = await inspect(), row = rows.find(value => value.name === role);
    if (!row) return {operationId, role, stage: 'runtime_absent'};
    if (row.marker !== `${marker}:runtime:${database}`) throw new Error('runtime identity mismatch or revoked');
    // Lock the durable activation row: no caller assertion can substitute for preparing evidence.
    await execute({...admin, database}, `BEGIN; DO $$ BEGIN PERFORM id FROM platform_upgrade_state WHERE id='global' FOR UPDATE; IF NOT EXISTS (SELECT 1 FROM platform_upgrade_state WHERE id='global' AND phase='preparing' AND generation=${literal(generation)} AND runtime_role=${literal(role)}) THEN RAISE EXCEPTION 'runtime is not preparing'; END IF; END $$;
ALTER ROLE ${ident(role)} NOLOGIN; COMMIT; SELECT to_json(true);`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await adminSql(`SELECT coalesce(json_agg(pg_terminate_backend(pid)), '[]'::json) FROM pg_stat_activity WHERE usename=${literal(role)} AND pid <> pg_backend_pid();`);
      if (await adminSql(`SELECT count(*)::int FROM pg_stat_activity WHERE usename=${literal(role)};`) === 0) break;
      if (Date.now() >= deadline) throw new Error('suspended runtime sessions remain');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return {operationId, role, database, stage: 'runtime_suspended'};
  }
  async function revokeRuntime(role) {
    ident(role);
    if (!known.has(role) || role === admin.role || role === runtimeRole) throw new Error('not a generated runtime identity');
    const rows = await inspect();
    if (!rows.some(row => row.name === role)) return {operationId, role, stage: 'runtime_revoked'};
    await adminSql(`BEGIN; ALTER ROLE ${ident(role)} NOLOGIN; COMMENT ON ROLE ${ident(role)} IS ${literal(rows.find(row => row.name === role).marker.replace(/(:revoked)+$/, '') + ':revoked')}; COMMIT; SELECT to_json(true);`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await adminSql(`SELECT coalesce(json_agg(pg_terminate_backend(pid)), '[]'::json) FROM pg_stat_activity WHERE usename=${literal(role)} AND pid <> pg_backend_pid();`);
      if (await adminSql(`SELECT count(*)::int FROM pg_stat_activity WHERE usename=${literal(role)};`) === 0) break;
      if (Date.now() >= deadline) throw new Error('revoked runtime sessions remain');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return {operationId, role, stage: 'runtime_revoked'};
  }
  return {bootstrap, inspect, fence, verify, createRuntime, suspendRuntime, revokeRuntime};
}
