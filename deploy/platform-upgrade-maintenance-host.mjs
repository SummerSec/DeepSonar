import {readFile, mkdir, chmod, rename, open} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {hostAdapter, platformValues} from './platform-upgrade-host.mjs';
import {assertDrained, forwardVersion, verifyBackup} from './platform-upgrade.mjs';
import {createDatabaseFence, databaseIdentity} from './platform-upgrade-database.mjs';
import {createCandidateManager} from './platform-upgrade-candidate.mjs';
import {runMaintenanceUpgrade} from './platform-upgrade-maintenance.mjs';
import {CONFIG_SNAPSHOT_SQL, PREFLIGHT_INPUT_SCHEMA, parsePreflightResult} from './platform-upgrade-preflight.mjs';
import {verifyMaintenanceWeb, assertMaintenanceDatabase} from './platform-upgrade-maintenance-health.mjs';
import {readSourceActivation, resumeRollback} from './platform-upgrade-maintenance-recovery.mjs';
import {loadManagedInventory, maintenanceNodes} from './platform-upgrade-maintenance-nodes.mjs';
import {createMaintenanceTransport, durablePrivateWrite, readPrivateJson} from './platform-upgrade-maintenance-transport.mjs';

const services = ['scheduler', 'web', 'image-admission'];
const imageKeys = ['DEEPSONAR_SCHEDULER_IMAGE', 'DEEPSONAR_WEB_IMAGE', 'DEEPSONAR_IMAGE_ADMISSION_IMAGE'];
const hash = value => createHash('sha256').update(value).digest('hex');
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const claimsSql = `SELECT json_build_object('claims_paused',claims_paused,'reason',claims_pause_reason,'drained',true,
'in_flight',json_build_object('total',(SELECT count(*) FROM jobs WHERE status IN ('claimed','provisioning','running'))),
'effect_pending_attempts',(SELECT count(*) FROM job_attempt_effects WHERE status='effect_pending'),
'unknown_effect_attempts',(SELECT count(*) FROM job_attempt_effects WHERE status='unknown')) FROM global_settings WHERE id='global'`;
const valuesFor = target => target.values ?? Object.fromEntries([['DEEPSONAR_VERSION', target.version], ...services.map((service, i) => [imageKeys[i], target.images[service].registry_refs.github])]);

export function maintenanceHostAdapter(options = {}) {
  const root = resolve(options.directory ?? dirname(fileURLToPath(import.meta.url)));
  const recovery = resolve(root, '.upgrade'), envPath = resolve(root, '.env');
  const projectName = options.projectName ?? 'deepsonar';
  const composeFiles = (options.composeFiles ?? ['docker-compose.prod.yml', 'docker-compose.real.yml', 'docker-compose.opensandbox.prod.yml']).map(path => resolve(root, path));
  const commandEnv = {...process.env};
  for (const key of ['DEEPSONAR_DATABASE_USER', 'DEEPSONAR_DATABASE_PASSWORD', 'DEEPSONAR_DATABASE_NAME', 'DEEPSONAR_UPGRADE_GENERATION']) if (Object.hasOwn(commandEnv, key)) throw new Error('unset deployment database/generation overrides before upgrade');
  const legacy = hostAdapter(options); // Retain official release verification and isolated test seams.
  const compose = ['compose', '-p', projectName, '--env-file', envPath, ...composeFiles.flatMap(path => ['-f', path])];
  const transport = createMaintenanceTransport({compose, commandEnv, run: options.run});
  const {run, dc} = transport;
  const parseValues = options.parsePlatformValues ?? platformValues;
  const rendered = values => JSON.parse(dc(['config', '--format', 'json'], undefined, {...commandEnv, ...values}).toString());
  const source = async () => {
    const env = await readFile(envPath, 'utf8'), values = parseValues(env);
    const config = rendered(values), url = new URL(config.services.scheduler.environment.DATABASE_URL);
    const postgres = config.services.postgres;
    const hostMode = postgres?.network_mode === 'host' && config.services.scheduler.network_mode === 'host';
    const containerNetwork = run(['inspect', '--format', '{{.HostConfig.NetworkMode}}', transport.pgContainer()]).toString().trim();
    const command = postgres?.command ?? [];
    const tokens = Array.isArray(command) ? command : command.split(/\s+/);
    const portToken = tokens.find(token => /^port=[0-9]+$/.test(token));
    const boundPort = portToken?.slice(5) ?? postgres?.environment?.PGPORT ?? '5432';
    if (hostMode ? containerNetwork !== 'host' || url.hostname !== '127.0.0.1' || (url.port || '5432') !== boundPort : url.hostname !== 'postgres' || (url.port && url.port !== '5432')) throw new Error('maintenance supports only the bound Compose PostgreSQL endpoint');
    const role = decodeURIComponent(url.username), database = decodeURIComponent(url.pathname.slice(1)), password = decodeURIComponent(url.password);
    if (![role, database].every(value => /^[a-z][a-z0-9_]{0,62}$/.test(value))) throw new Error('unsupported database identity');
    return {env, values, role, password, database, port: Number(url.port || 5432)};
  };
  const secretPath = state => resolve(recovery, `identity-${state.generation}.json`);
  const secrets = async state => {
    const value = await readPrivateJson(secretPath(state));
    if (!value || value.generation !== state.generation || value.bindingHash !== hash(JSON.stringify(state.binding))) throw new Error('recovery identity missing or binding mismatch');
    return value;
  };
  const image = state => valuesFor(state.target).DEEPSONAR_SCHEDULER_IMAGE;
  const adminRows = async (state, input) => {const saved = await secrets(state); return transport.rows({image: image(state), ...saved.admin, port: saved.source.port, ...input});};
  const adminScalar = async (state, input) => Object.values((await adminRows(state, input))[0] ?? {})[0];
  const fenceFor = async state => {
    const saved = await secrets(state);
    return createDatabaseFence({runSql: input => transport.scalar({image: image(state), port: saved.source.port, ...input}), runtimeRole: saved.source.role, bootstrapPassword: saved.source.password,
      admin: saved.admin, adminOperationId: saved.adminOperationId, expectedClusterSystemIdentifier: saved.clusterId, operationId: state.generation,
      runtimeIdentities: [saved.runtime.role, saved.rollbackRuntime.role], dedicatedDatabases: [saved.source.database, saved.candidateDatabase]});
  };
  const nodesFor = async state => {
    const saved = await secrets(state);
    return maintenanceNodes({inventory: saved.inventory, registeredWorkerIds: saved.registeredWorkerIds, transport: options.nodeTransport, run, commandEnv});
  };
  const checkClaims = async state => {const saved = await secrets(state); const result = await adminScalar(state, {database: saved.source.database, sql: claimsSql}); assertDrained(result);
    const scans = await adminScalar(state, {database: saved.source.database, sql: "SELECT count(*)::int FROM runtime_image_scans WHERE status IN ('claimed','running')"});
    if (scans !== 0) throw new Error('image admission scans must settle before backup'); return result;};
  const stop = () => dc(['stop', ...services]);
  const patchEnv = async (base, replacements) => {
    let contents = base;
    for (const [key, value] of Object.entries(replacements)) {
      if (!/^[A-Z_]+$/.test(key) || /[\r\n]/.test(value)) throw new Error('invalid deployment configuration');
      const matches = contents.split(/\r?\n/).filter(line => new RegExp(`^\\s*(?:export\\s+)?${key}(?:\\s*[=:]|\\s*$)`).test(line));
      if (matches.length > 1 || (matches.length === 1 && !matches[0].startsWith(`${key}=`))) throw new Error('ambiguous deployment configuration');
      contents = matches.length ? contents.replace(new RegExp(`^${key}=.*$`, 'gm'), `${key}=${value}`) : `${contents.trimEnd()}\n${key}=${value}\n`;
    }
    parseValues(contents); await durablePrivateWrite(envPath, contents);
  };
  const candidateManager = async state => {
    const saved = await secrets(state), databaseFence = await fenceFor(state);
    return createCandidateManager({sourceDatabase: saved.source.database, operationId: state.generation.replaceAll('-', ''),
      runSql: input => adminRows(state, input),
      verifyFence: async ({candidateDatabase} = {}) => {
        const receipt = await databaseFence.verify();
        let candidate_writes_blocked = false;
        if (candidateDatabase) {
          const roles = await adminRows(state, {database: 'postgres', sql: `SELECT rolcanlogin FROM pg_roles WHERE rolname=${literal(saved.runtime.role)}`});
          const sessions = await adminScalar(state, {database: 'postgres', sql: `SELECT count(*)::int FROM pg_stat_activity WHERE datname=${literal(candidateDatabase)} AND usename<>CURRENT_USER`});
          candidate_writes_blocked = roles.every(role => role.rolcanlogin === false) && sessions === 0;
        }
        return {ok: true, operation_id: state.generation.replaceAll('-', ''), source_database: saved.source.database, epoch: receipt.epoch,
          activation: (await adapter.inspectActivation(state)).status, candidate_writes_blocked};
      },
      verifyBackup: backup => adapter.verifyBackup(state, backup),
      runRestore: async ({database, backup}) => {
        const {dump} = verifyBackup(await readFile(resolve(recovery, backup.file)), backup.sha256);
        transport.archive({action: 'pg_restore', ...saved.admin, port: saved.source.port, database, input: dump});
      },
      runTargetCli: input => transport.schema({image: image(state), ...saved.admin, port: saved.source.port, database: input.candidate_database, source_schema_sha256: state.plan.source_schema_sha256, ...input}),
    });
  };
  const health = () => JSON.parse(dc(['exec', '-T', 'scheduler', 'node', '-e', "fetch('http://127.0.0.1:'+(process.env.SCHEDULER_PORT||'3100')+'/health').then(async r=>{if(!r.ok)throw Error();console.log(await r.text())}).catch(()=>process.exit(1))"]).toString());
  const verifyDatabase = async (state, phase) => {
    const saved = await secrets(state);
    const rows = await adminRows(state, {database: saved.candidateDatabase, sql: "SELECT p.phase,p.generation,p.runtime_role,p.target_version,(SELECT version FROM schema_meta WHERE id='global') AS schema_version,(SELECT claims_paused FROM global_settings WHERE id='global') AS claims_paused FROM platform_upgrade_state p WHERE p.id='global'"});
    assertMaintenanceDatabase(rows[0], {state, saved, phase});
  };
  const verifyContainers = state => {
    const expected = valuesFor(state.target);
    for (let i = 0; i < services.length; i++) {
      const id = dc(['ps', '-q', services[i]]).toString().trim();
      if (!/^[a-f0-9]{12,64}$/.test(id) || run(['inspect', '--format', '{{.Config.Image}}', id]).toString().trim() !== expected[imageKeys[i]]) throw new Error('platform image verification failed');
    }
  };
  const adapter = {
    lock: legacy.lock,
    readJournal: () => readPrivateJson(resolve(recovery, 'maintenance.json')),
    writeJournal: async state => {await mkdir(recovery, {recursive: true, mode: 0o700}); await chmod(recovery, 0o700); await durablePrivateWrite(resolve(recovery, 'maintenance.json'), JSON.stringify(state));},
    async deploymentBinding() {
      const context = commandEnv.DOCKER_CONTEXT || (commandEnv.DOCKER_HOST ? null : run(['context', 'show']).toString().trim());
      const endpoint = context ? JSON.parse(run(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']).toString()) : commandEnv.DOCKER_HOST;
      if (!endpoint) throw new Error('Docker endpoint identity unavailable');
      const mounts = JSON.parse(run(['inspect', '--format', '{{json .Mounts}}', transport.pgContainer()]).toString());
      const postgresStorage = mounts.filter(mount => mount.Destination === '/var/lib/postgresql/data').map(mount => ({type: mount.Type, name: mount.Name, source: mount.Source, destination: mount.Destination}));
      if (postgresStorage.length !== 1) throw new Error('PostgreSQL durable storage binding unavailable');
      return {root, projectName, postgresStorageHash: hash(JSON.stringify(postgresStorage)), inventoryHash: hash(JSON.stringify(await loadManagedInventory(options.nodes))), composeFiles, composeHashes: await Promise.all(composeFiles.map(async path => hash(await readFile(path)))), dockerIdentity: hash(JSON.stringify({context, endpoint}))};
    },
    async resolveTarget() {const target = await legacy.release(); await legacy.pull(target); return target;},
    async plan(target) {
      const prior = await source(), values = valuesFor(target);
      verifyContainers({target: {values: prior.values}});
      const source_schema_sha256 = run(['run', '--rm', '--network=none', '--read-only', '--entrypoint=node', prior.values.DEEPSONAR_SCHEDULER_IMAGE, '-e', "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/app/database/schema.sql')).digest('hex'))"]).toString().trim();
      if (!/^[a-f0-9]{64}$/.test(source_schema_sha256)) throw new Error('source schema fingerprint invalid');
      const cli = await transport.schema({image: values.DEEPSONAR_SCHEDULER_IMAGE, role: prior.role, password: prior.password, database: prior.database, port: prior.port, action: 'plan', source_database: prior.database, source_schema_sha256});
      if (!cli.plan) throw new Error('target schema planning failed');
      const snapshot = await transport.scalar({image: values.DEEPSONAR_SCHEDULER_IMAGE, ...prior, sql: CONFIG_SNAPSHOT_SQL});
      const environment = rendered(values).services.scheduler.environment;
      const result = run(['run', '--rm', '-i', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--entrypoint=node', values.DEEPSONAR_SCHEDULER_IMAGE, '/app/apps/scheduler/dist/platform-upgrade-preflight-cli.js'], JSON.stringify({...snapshot, schema: PREFLIGHT_INPUT_SCHEMA, target_schema_version: target.schema_version, environment}), commandEnv, [0, 1]);
      const preflight = parsePreflightResult(result.stdout ?? result);
      const registeredWorkerIds = await transport.scalar({image: values.DEEPSONAR_SCHEDULER_IMAGE, ...prior, sql: "SELECT coalesce(json_agg(id ORDER BY id),'[]'::json) FROM worker_nodes WHERE kind='remote'"});
      const inventory = await loadManagedInventory(options.nodes);
      const blocking_errors = [...cli.plan.blocking_errors, ...preflight.blocking_errors.filter(error => error.code !== 'DATABASE_SCHEMA_MISMATCH')];
      try {maintenanceNodes({inventory, registeredWorkerIds, transport: options.nodeTransport, run, commandEnv});} catch {blocking_errors.push({code: 'MANAGED_NODE_INVENTORY_MISMATCH'});}
      if (!forwardVersion(prior.values.DEEPSONAR_VERSION, target.version)) blocking_errors.push({code: 'TARGET_NOT_NEWER'});
      if (options.resetRoleIdentity) blocking_errors.push({code: 'RESET_ROLE_IDENTITY_NOT_AVAILABLE'});
      return {...cli.plan, source_schema_sha256, source_environment_sha256: hash(prior.env), blocking_errors, preflight};
    },
    async prepareIdentity(state) {
      let saved = await readPrivateJson(secretPath(state));
      if (!saved) {
        const prior = await source();
        if (hash(prior.env) !== state.plan.source_environment_sha256) throw new Error('source deployment changed after the approved plan');
        const cluster = await readPrivateJson(resolve(recovery, 'cluster-admin.json'));
        saved = {generation: state.generation, bindingHash: hash(JSON.stringify(state.binding)), source: prior,
          admin: cluster?.admin ?? databaseIdentity('ds_maintenance'), adminOperationId: cluster?.operationId ?? state.generation, clusterId: cluster?.clusterId,
          candidateDatabase: `ds_upgrade_${state.generation.replaceAll('-', '')}`, runtime: databaseIdentity('ds_runtime'), rollbackRuntime: databaseIdentity('ds_rollback'),
          workerToken: randomBytes(32).toString('hex'), inventory: await loadManagedInventory(options.nodes),
          registeredWorkerIds: await transport.scalar({image: image(state), ...prior, sql: "SELECT coalesce(json_agg(id ORDER BY id),'[]'::json) FROM worker_nodes WHERE kind='remote'"})};
        await durablePrivateWrite(secretPath(state), JSON.stringify(saved));
      }
      await secrets(state);
      const receipt = await (await fenceFor(state)).bootstrap();
      const clusterId = await adminScalar(state, {database: 'postgres', sql: 'SELECT system_identifier::text FROM pg_control_system()'});
      const cluster = await readPrivateJson(resolve(recovery, 'cluster-admin.json'));
      if (cluster && cluster.clusterId !== clusterId) throw new Error('maintenance cluster identity changed');
      saved.clusterId = clusterId; await durablePrivateWrite(secretPath(state), JSON.stringify(saved));
      await durablePrivateWrite(resolve(recovery, 'cluster-admin.json'), JSON.stringify({admin: saved.admin, operationId: saved.adminOperationId, clusterId}));
      return receipt;
    },
    async pauseAndDrain(state) {
      if (state.receipts.fence) {await checkClaims(state); return {paused: true};}
      const claims = await legacy.claims();
      if (claims.claims_paused && claims.reason !== 'platform_upgrade') throw new Error('operator pause must be preserved');
      if (!claims.claims_paused) await legacy.pause();
      await legacy.drain(); await checkClaims(state); return {paused: true};
    },
    async fence(state) {await checkClaims(state); const receipt = await (await fenceFor(state)).fence(); stop(); await (await nodesFor(state)).fence(state.generation); await checkClaims(state); return receipt;},
    async backup(state) {
      const saved = await secrets(state), file = `maintenance-${state.generation}.dump.gz`, path = resolve(recovery, file);
      if (state.receipts.backup) {await adapter.verifyBackup(state, state.receipts.backup); return state.receipts.backup;}
      await (await fenceFor(state)).verify(); await checkClaims(state);
      const bytes = gzipSync(transport.archive({action: 'pg_dump', ...saved.admin, port: saved.source.port, database: saved.source.database}));
      const {hash: sha256} = verifyBackup(bytes); await durablePrivateWrite(path, bytes);
      const receipt = {file, sha256, operation_id: state.generation.replaceAll('-', ''), source_database: saved.source.database, fence_epoch: state.generation};
      await adapter.verifyBackup(state, receipt); return receipt;
    },
    async verifyBackup(state, backup) {
      if (backup.file !== `maintenance-${state.generation}.dump.gz`) throw new Error('backup binding mismatch');
      const {dump} = verifyBackup(await readFile(resolve(recovery, backup.file)), backup.sha256);
      const list = run(['exec', '-i', transport.pgContainer(), 'pg_restore', '--list'], dump).toString();
      if (!list.includes('TABLE DATA public global_settings') || !list.includes('TABLE DATA public schema_meta')) throw new Error('backup required tables missing');
      return {...backup, ok: true};
    },
    async candidate(state) {
      stop(); const saved = await secrets(state);
      const roles = await adminRows(state, {database: 'postgres', sql: `SELECT rolcanlogin FROM pg_roles WHERE rolname=${literal(saved.runtime.role)}`});
      if (roles.length) {
        await (await fenceFor(state)).suspendRuntime(saved.runtime.role, {database: saved.candidateDatabase, generation: state.generation});
      }
      const receipt = await (await candidateManager(state)).restore(state.receipts.backup);
      if (receipt.database !== saved.candidateDatabase) {saved.candidateDatabase = receipt.database; await durablePrivateWrite(secretPath(state), JSON.stringify(saved));}
      return receipt;
    },
    async rebuild(state) {
      const manager = await candidateManager(state); await manager.restore(state.receipts.backup);
      const result = await manager.apply(state.receipts.backup, state.plan.plan_hash);
      if (!result.ok) throw new Error('candidate schema rebuild blocked');
      return {ok: true, plan_hash: state.plan.plan_hash};
    },
    async configurePreparing(state) {
      const saved = await secrets(state);
      await adminRows(state, {database: saved.candidateDatabase, sql: `UPDATE platform_upgrade_state SET phase='preparing',generation=${literal(state.generation)},runtime_role=${literal(saved.runtime.role)},target_version=${literal(state.target.version)},worker_generation_token_hash=${literal(hash(saved.workerToken))} WHERE id='global'`});
      await (await fenceFor(state)).createRuntime({...saved.runtime, database: saved.candidateDatabase});
      await patchEnv(saved.source.env, {...valuesFor(state.target), DEEPSONAR_DATABASE_USER: saved.runtime.role, DEEPSONAR_DATABASE_PASSWORD: saved.runtime.password, DEEPSONAR_DATABASE_NAME: saved.candidateDatabase, DEEPSONAR_UPGRADE_GENERATION: state.generation});
      return {configured: true, database: saved.candidateDatabase};
    },
    async startPreparing(state) {dc(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', ...services]);
      await (await nodesFor(state)).prepare({generation: state.generation, target: state.target, values: valuesFor(state.target), saved: await secrets(state)}); return {started: true};},
    async verifyPreparing(state) {
      const deadline = Date.now() + (options.readyTimeoutMs ?? 180000);
      while (true) {
        try {const result = health(); if (result.maintenance === true && result.maintenance_ready === true && result.upgrade_generation === state.generation && result.version === state.target.version) break;} catch { /* Bounded readiness polling. */ }
        if (Date.now() >= deadline) throw new Error('maintenance readiness timeout');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await verifyDatabase(state, 'preparing'); await verifyMaintenanceWeb({dc, webUrl: options.webUrl});
      verifyContainers(state); const nodes = await (await nodesFor(state)).verify({generation: state.generation, target: state.target, active: false}); return {ok: true, nodes};
    },
    async inspectActivation(state) {
      const saved = await readPrivateJson(secretPath(state));
      if (!saved) return {status: 'inactive', generation: state.generation};
      try {
        const sourceActivation = await readSourceActivation({state, saved, scalar: input => adminScalar(state, input)});
        if (sourceActivation) return {status: 'active', generation: state.generation, receipt_id: sourceActivation.generation, source_resumed: true};
        const exists = await adminScalar(state, {database: 'postgres', sql: `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${literal(saved.candidateDatabase)})`});
        if (!exists) return {status: 'inactive', generation: state.generation};
        const table = await adminScalar(state, {database: saved.candidateDatabase, sql: "SELECT to_regclass('public.platform_upgrade_state') IS NOT NULL"});
        if (!table) return {status: 'inactive', generation: state.generation};
        const rows = await adminRows(state, {database: saved.candidateDatabase, sql: "SELECT phase,generation,runtime_role,target_version FROM platform_upgrade_state WHERE id='global'"});
        const row = rows[0];
        if (row?.phase === 'active' && row.generation === state.generation && row.runtime_role === saved.runtime.role && row.target_version === state.target.version) return {status: 'active', generation: state.generation, receipt_id: state.generation};
        if (!row || row.phase === 'preparing' || row.generation !== state.generation) return {status: 'inactive', generation: state.generation};
      } catch {
        try {
          const absent = await transport.scalar({image: image(state), role: saved.source.role, password: saved.source.password, database: 'postgres', sql: `SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=${literal(saved.candidateDatabase)})`});
          if (absent === true) return {status: 'inactive', generation: state.generation};
        } catch { /* Unknown database authority must not authorize rollback. */ }
        return {status: 'unknown', generation: state.generation};
      }
      return {status: 'unknown', generation: state.generation};
    },
    async activate(state) {
      const saved = await secrets(state); await adapter.verifyPreparing(state);
      const activated = await adminScalar(state, {database: saved.candidateDatabase, sql: `BEGIN; SELECT id FROM platform_upgrade_state WHERE id='global' FOR UPDATE;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM platform_upgrade_state WHERE id='global' AND phase='preparing' AND generation=${literal(state.generation)} AND runtime_role=${literal(saved.runtime.role)} AND target_version=${literal(state.target.version)}) THEN RAISE EXCEPTION 'generation mismatch'; END IF; END$$;
UPDATE global_settings SET claims_paused=false,claims_pause_reason=NULL,claims_pause_note=NULL,claims_paused_by=NULL,claims_paused_at=NULL WHERE id='global';
UPDATE platform_upgrade_state SET phase='active' WHERE id='global'; COMMIT; SELECT true;`});
      if (activated !== true) throw new Error('activation response invalid');
      return {active: true, generation: state.generation, receipt_id: state.generation};
    },
    async verifyActive(state) {
      const actual = await adapter.inspectActivation(state); if (actual.status !== 'active' || actual.source_resumed) throw new Error('target active generation missing; use resume-rollback for source repair');
      const deadline = Date.now() + (options.readyTimeoutMs ?? 180000);
      while (true) {try {const result = health(); if (result.ready === true && result.version === state.target.version) break;} catch { /* Retry bounded startup. */ }
        if (Date.now() >= deadline) throw new Error('active readiness timeout'); await new Promise(resolve => setTimeout(resolve, 1000));}
      const saved = await secrets(state);
      const workerDeadline = Date.now() + (options.readyTimeoutMs ?? 180000);
      while (saved.registeredWorkerIds.length) {
        const workers = await adminRows(state, {database: saved.candidateDatabase, sql: "SELECT id,platform_version,deployment_generation,status,protocol_version,(last_heartbeat_at > now()-interval '60 seconds') AS fresh FROM worker_nodes WHERE kind='remote'"});
        if (saved.registeredWorkerIds.every(id => workers.some(worker => worker.id === id && worker.platform_version === state.target.version && worker.deployment_generation === state.generation && worker.status === 'online' && worker.protocol_version === 1 && worker.fresh === true))) break;
        if (Date.now() >= workerDeadline) throw new Error('managed worker generation admission timeout');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await verifyDatabase(state, 'active'); await verifyMaintenanceWeb({dc, webUrl: options.webUrl});
      verifyContainers(state); const nodes = await (await nodesFor(state)).verify({generation: state.generation, target: state.target, active: true}); return {ok: true, nodes};
    },
    async archiveCompleted(state) {
      if (state.status === 'complete') await adapter.verifyActive(state);
      else if (state.status === 'rollback_resumed') await adapter.resumeRollback(state);
      else throw new Error('unfinished maintenance generation cannot be archived');
      await rename(resolve(recovery, 'maintenance.json'), resolve(recovery, `maintenance-${state.generation}.completed.json`));
      const directory = await open(recovery, 'r'); try {await directory.sync();} finally {await directory.close();}
    },
    async resumeRollback(state) {
      const saved = await secrets(state), nodes = await nodesFor(state);
      const sourceTarget = {version: saved.source.values.DEEPSONAR_VERSION, values: saved.source.values};
      const startSource = async () => {dc(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', ...services]);};
      const waitSource = async preparing => {
        const deadline = Date.now() + (options.readyTimeoutMs ?? 180000);
        while (true) {
          try {const value = health(); if (value.version === sourceTarget.version && (preparing ? value.maintenance_ready === true && value.upgrade_generation === saved.rollbackGeneration : value.ready === true)) break;} catch {}
          if (Date.now() >= deadline) throw new Error('source readiness failed; preserve recorded activation boundary');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await verifyMaintenanceWeb({dc, webUrl: options.webUrl}); verifyContainers({target: sourceTarget});
        await nodes.verify({generation: saved.rollbackGeneration, target: sourceTarget, active: !preparing});
      };
      return resumeRollback({state, saved, scalar: input => adminScalar(state, input), rows: input => adminRows(state, input),
        saveJournal: adapter.writeJournal, saveSecrets: value => durablePrivateWrite(secretPath(state), JSON.stringify(value)),
        inspectCandidate: () => adapter.inspectActivation(state),
        configure: async maintenance => {
          const databaseFence = await fenceFor(state);
          await databaseFence.verify(); await databaseFence.revokeRuntime(saved.runtime.role);
          await databaseFence.createRuntime({...saved.rollbackRuntime, database: saved.source.database});
          if (maintenance) await adminRows(state, {database: saved.source.database, sql: `UPDATE platform_upgrade_state SET phase='preparing',generation=${literal(saved.rollbackGeneration)},runtime_role=${literal(saved.rollbackRuntime.role)},target_version=${literal(sourceTarget.version)},worker_generation_token_hash=${literal(hash(saved.rollbackWorkerToken))} WHERE id='global'`});
          await patchEnv(saved.source.env, {DEEPSONAR_DATABASE_USER: saved.rollbackRuntime.role, DEEPSONAR_DATABASE_PASSWORD: saved.rollbackRuntime.password, DEEPSONAR_DATABASE_NAME: saved.source.database, DEEPSONAR_UPGRADE_GENERATION: maintenance ? saved.rollbackGeneration : ''});
          if (maintenance) {
            await startSource();
            await nodes.prepare({generation: saved.rollbackGeneration, target: sourceTarget, values: saved.source.values,
              saved: {...saved, runtime: saved.rollbackRuntime, candidateDatabase: saved.source.database, workerToken: saved.rollbackWorkerToken}});
            await waitSource(true);
          }
        },
        start: startSource,
        verify: async () => {
          await waitSource(false);
          const deadline = Date.now() + (options.readyTimeoutMs ?? 180000);
          while (saved.registeredWorkerIds.length) {
            const workers = await adminRows(state, {database: saved.source.database, sql: "SELECT id,platform_version,deployment_generation,status,protocol_version,(last_heartbeat_at>now()-interval '60 seconds') AS fresh FROM worker_nodes WHERE kind='remote'"});
            if (saved.registeredWorkerIds.every(id => workers.some(worker => worker.id === id && worker.platform_version === sourceTarget.version && worker.deployment_generation === saved.rollbackGeneration && worker.status === 'online' && worker.protocol_version === 1 && worker.fresh === true))) break;
            if (Date.now() >= deadline) throw new Error('source worker generation admission timeout');
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        },
      });
    },
    async rollbackPreparing(state) {
      const saved = await readPrivateJson(secretPath(state));
      if (!saved) return {unchanged: true, paused: false, receipt_id: state.generation};
      const databaseFence = await fenceFor(state);
      // Even a failed pause response may have taken effect. Preserve the source,
      // stop all writers, retire target identity and leave rollback apps stopped.
      stop(); await (await nodesFor(state)).fence(state.generation); await databaseFence.bootstrap(); await databaseFence.fence(); await databaseFence.revokeRuntime(saved.runtime.role);
      await adminRows(state, {database: saved.source.database, sql: "UPDATE global_settings SET claims_paused=true,claims_pause_reason='platform_upgrade',claims_pause_note=NULL,claims_paused_by='platform_upgrade_host',claims_paused_at=now() WHERE id='global'"});
      await databaseFence.createRuntime({...saved.rollbackRuntime, database: saved.source.database});
      await patchEnv(saved.source.env, {DEEPSONAR_DATABASE_USER: saved.rollbackRuntime.role, DEEPSONAR_DATABASE_PASSWORD: saved.rollbackRuntime.password, DEEPSONAR_DATABASE_NAME: saved.source.database, DEEPSONAR_UPGRADE_GENERATION: ''});
      await checkClaims(state);
      return {paused: true, source_selected: true, apps_stopped: true, receipt_id: state.generation};
    },
  };
  return adapter;
}
export async function runHostMaintenance(action, options = {}) {
  const io = maintenanceHostAdapter(options);
  return io.lock(async () => {
    if (action === 'resume-rollback') {
      const state = await io.readJournal();
      if (!state || JSON.stringify(state.binding) !== JSON.stringify(await io.deploymentBinding())) throw new Error('rollback deployment binding mismatch');
      return io.resumeRollback(state);
    }
    const prior = await io.readJournal();
    if (action === 'apply' && prior && ['complete', 'rollback_resumed'].includes(prior.status) && options.version && prior.requestedTarget !== options.version) {
      if (JSON.stringify(prior.binding) !== JSON.stringify(await io.deploymentBinding())) throw new Error('completed deployment binding mismatch');
      await io.archiveCompleted(prior);
    }
    return runMaintenanceUpgrade(io, {action, target: options.version, approvedPlanHash: options.approvedPlanHash});
  });
}
