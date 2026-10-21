// Host-only CLI: node deploy/platform-upgrade-host.mjs check|apply|rollback [--version X.Y.Z]
// Requires Node >=22, Docker Compose/buildx, and DEEPSONAR_ADMIN_TOKEN in process env.
// Maintenance upgrade CLI; programmatic hostAdapter retains isolated legacy test seams.
import { readFile, writeFile, rename, mkdir, rm, open, chmod } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgrade, assertDrained, verifyBackup } from './platform-upgrade.mjs';
import { CONFIG_SNAPSHOT_SQL, preflightBlock, targetConfigurationPreflight } from './platform-upgrade-preflight.mjs';
import { verifyPlatformRelease } from '../agent-harness/check-platform-release.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const keys = { scheduler: 'DEEPSONAR_SCHEDULER_IMAGE', web: 'DEEPSONAR_WEB_IMAGE', 'image-admission': 'DEEPSONAR_IMAGE_ADMISSION_IMAGE' };
const services = Object.keys(keys);
const maxBuffer = 512 * 1024 * 1024;

export function platformValues(contents) {
  const result = {};
  for (const key of ['DEEPSONAR_VERSION', ...Object.values(keys)]) {
    const lines = contents.split(/\r?\n/).filter(line => new RegExp(`^\\s*(?:export\\s+)?${key}(?:\\s*[=:]|\\s*$)`).test(line));
    if (lines.length !== 1 || !lines[0].startsWith(`${key}=`)) throw new Error(`ambiguous/missing ${key}`);
    const value = lines[0].slice(key.length + 1);
    if (key === 'DEEPSONAR_VERSION' ? !/^\d+\.\d+\.\d+$/.test(value) : !new RegExp(`^(?:ghcr\\.io/summersec|docker\\.io/summersec|crpi-6s5wwv0nhl6dq1l0\\.cn-hangzhou\\.personal\\.cr\\.aliyuncs\\.com/summersec)/deepsonar-${Object.keys(keys).find(name => keys[name] === key)}@sha256:[a-f0-9]{64}$`).test(value)) {
      throw new Error(`unsupported ${key}; upgrade requires official registry digest references for the matching service`);
    }
    result[key] = value;
  }
  if (/^\s*(?:export\s+)?DEEPSONAR_IMAGE_TAG(?:\s*[=:]|\s*$)/m.test(contents)) throw new Error('obsolete platform image variable');
  return result;
}

async function atomic(path, contents) {
  const temp = `${path}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}

export function hostAdapter(options = {}) {
  // Programmatic seams support isolated integration fixtures. The CLI below
  // never maps arguments or environment variables to these trust dependencies.
  const parseValues = options.parsePlatformValues ?? platformValues;
  const projectName = options.projectName ?? 'deepsonar';
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(projectName)) throw new Error('invalid Compose project name');
  const root = options.directory ?? dir;
  const envPath = resolve(root, '.env');
  const recovery = resolve(root, '.upgrade');
  const journal = resolve(recovery, 'state.json');
  const commandEnv = { ...process.env };
  // Never let exported platform variables override the journaled dotenv configuration.
  for (const key of ['DEEPSONAR_VERSION', 'DEEPSONAR_IMAGE_TAG', ...Object.values(keys)]) {
    if (Object.hasOwn(commandEnv, key)) throw new Error(`unset ${key} before upgrade`);
  }
  const composeFiles = (options.composeFiles ?? ['docker-compose.prod.yml', 'docker-compose.real.yml', 'docker-compose.opensandbox.prod.yml']).map(file => resolve(root, file));
  const compose = ['compose', '-p', projectName, '--env-file', envPath];
  for (const file of composeFiles) compose.push('-f', file);
  const run = options.run ?? ((args, input, env = commandEnv, allowedStatuses = [0]) => {
    const output = spawnSync('docker', args, { env, input, maxBuffer, timeout: 600_000 });
    if (output.error || !allowedStatuses.includes(output.status)) throw new Error(`docker ${args[0]} failed (status ${output.status ?? 'unknown'}); inspect local Docker logs`);
    return allowedStatuses.length > 1 ? {stdout: output.stdout, status: output.status} : output.stdout;
  });
  let boundTarget;
  const deploymentTarget = () => {
    const context = commandEnv.DOCKER_CONTEXT || (commandEnv.DOCKER_HOST ? null : run(['context', 'show']).toString().trim());
    const endpoint = context
      ? JSON.parse(run(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']).toString())
      : commandEnv.DOCKER_HOST;
    if (!endpoint || (context !== null && !context)) throw new Error('cannot identify Docker deployment target');
    // Hash the endpoint/context identity: never persist URLs that might contain credentials.
    const dockerIdentity = createHash('sha256').update(JSON.stringify({context, endpoint})).digest('hex');
    const composeFileHashes = composeFiles.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'));
    const current = {projectName, envPath, composeFiles, composeFileHashes, dockerIdentity};
    if (boundTarget && JSON.stringify(current) !== JSON.stringify(boundTarget)) throw new Error('Docker deployment target changed during upgrade');
    boundTarget = current;
    return current;
  };
  const dc = (args, input, env) => run([...compose, ...args], input, env);
  const sql = query => dc(['exec', '-T', 'postgres', 'psql', '-U', 'deepsonar', '-d', 'deepsonar', '-v', 'ON_ERROR_STOP=1', '-Atc', query]).toString().trim();
  const base = new URL(options.api ?? 'http://127.0.0.1:8080/api/');
  // Treat --api as a directory so the production Web proxy's /api prefix survives.
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname))) throw new Error('API must use HTTPS or loopback HTTP');
  const request = async (path, body, timeoutMs = 15_000) => {
    const token = process.env.DEEPSONAR_ADMIN_TOKEN;
    if (!token) throw new Error('DEEPSONAR_ADMIN_TOKEN is required in process environment');
    const response = await fetch(new URL(path.replace(/^\/+/, ''), base), { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs)), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`management API ${path} failed (${response.status})`);
    return response.json();
  };
  const imageValues = target => target.values ?? Object.fromEntries([
    ['DEEPSONAR_VERSION', target.version], ...services.map(service => [keys[service], target.images[service].registry_refs.github]),
  ]);
  const verifyImages = target => {
    for (const service of services) {
      const container = dc(['ps', '-q', service]).toString().trim();
      if (!container || container.includes('\n')) throw new Error('expected one platform container per service');
      const actual = run(['inspect', '--format', '{{.Config.Image}}', container]).toString().trim();
      if (actual !== imageValues(target)[keys[service]]) throw new Error(`${service} digest verification failed`);
    }
  };
  const adapter = {
    async lock(fn) {
      await mkdir(recovery, { recursive: true, mode: 0o700 });
      await chmod(recovery, 0o700);
      const lockPath = resolve(recovery, 'lock');
      try { await mkdir(lockPath, { mode: 0o700 }); } catch { throw new Error('upgrade lock exists; verify no upgrade process runs before manually removing .upgrade/lock'); }
      try { await writeFile(resolve(lockPath, 'pid'), String(process.pid)); return await fn(); }
      finally { await rm(lockPath, { recursive: true }); }
    },
    async readState() {
      let state;
      try { state = JSON.parse(await readFile(journal, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (JSON.stringify(state.deploymentTarget) !== JSON.stringify(deploymentTarget())) {
        throw new Error('recovery deployment target missing or different; refusing to operate on another project, configuration or Docker endpoint');
      }
      return state;
    },
    writeState: state => atomic(journal, JSON.stringify({...state, deploymentTarget: deploymentTarget()}, null, 2)),
    async release() {
      if (options.releaseProvider) return options.releaseProvider();
      const version = options.version?.replace(/^v/, '');
      if (version && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be stable X.Y.Z');
      const url = `https://github.com/SummerSec/DeepSonar/releases/${version ? `download/v${version}` : 'latest/download'}/runtime-image-registry.json`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`official release fetch failed (${response.status})`);
      const catalog = await response.json();
      verifyPlatformRelease(catalog);
      if (version && catalog.platform.version !== version) throw new Error('release version mismatch');
      return catalog.platform;
    },
    async current() {
      const values = parseValues(await readFile(envPath, 'utf8'));
      const schema = Number(sql("SELECT version FROM schema_meta WHERE id='global'"));
      if (!Number.isSafeInteger(schema) || schema < 1) throw new Error('invalid current schema');
      const health = await request('/health');
      if (health.version !== values.DEEPSONAR_VERSION || health.ok !== true) throw new Error('running version does not match deployment configuration');
      const current = { version: values.DEEPSONAR_VERSION, schema, values };
      verifyImages(current);
      return current;
    },
    async pull(target) { for (const service of services) run(['pull', imageValues(target)[keys[service]]]); },
    async preflight(target) {
      let remoteCount;
      try { remoteCount = sql("SELECT count(*) FROM worker_nodes WHERE kind='remote'"); }
      catch { return preflightBlock('HOST_WORKER_SNAPSHOT_FAILED', 'host.worker_nodes', 'Could not verify the single-host upgrade prerequisite.'); }
      if (remoteCount !== '0') return preflightBlock('HOST_REMOTE_WORKERS_UNSUPPORTED', 'host.worker_nodes', 'Remote workers require a coordinated upgrade; this CLI supports one Compose host only.');
      return targetConfigurationPreflight({target, values: imageValues(target), commandEnv, dc, run, snapshotSql: CONFIG_SNAPSHOT_SQL});
    },
    async schemaPlan() { throw new Error('schema differs: review target schema-rebuild-cli --plan with a read-only database role; automatic rebuild is not supported'); },
    claims: () => request('/platform/claims'),
    pause: () => request('/platform/claims/pause', { reason: 'platform_upgrade' }),
    resume: () => request('/platform/claims/resume', { reason: 'platform_upgrade' }),
    async drain() {
      const deadline = Date.now() + (options.drainTimeoutMs ?? 300_000);
      while (true) {
        try { assertDrained(await adapter.claims()); return; } catch (error) { if (Date.now() >= deadline) throw error; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    },
    async backup() {
      const dump = dc(['exec', '-T', 'postgres', 'pg_dump', '-U', 'deepsonar', '-d', 'deepsonar', '-Fc']);
      const bytes = gzipSync(dump), { hash } = verifyBackup(bytes);
      const file = `database-${Date.now()}.dump.gz`;
      await atomic(resolve(recovery, file), bytes);
      return { file, hash };
    },
    async verifyBackup(backup) {
      if (!/^[a-f0-9]{64}$/.test(backup.hash) || !/^database-\d+\.dump\.gz$/.test(backup.file)) throw new Error('invalid backup path');
      const { dump } = verifyBackup(await readFile(resolve(recovery, backup.file)), backup.hash);
      const list = dc(['exec', '-T', 'postgres', 'pg_restore', '--list'], dump).toString();
      if (!/TABLE DATA public global_settings/.test(list) || !/TABLE DATA public schema_meta/.test(list)) throw new Error('backup lacks required control/schema data');
      return dump;
    },
    async stop() {
      // --api can point at the wrong deployment. Never trust its pause/drain
      // response as authority to stop this Compose project's running services.
      assertDrained(await adapter.recoveryClaims());
      dc(['stop', 'scheduler', 'image-admission', 'web']);
    },
    async recoveryClaims() {
      const value = sql(`SELECT json_build_object(
        'claims_paused', claims_paused, 'reason', claims_pause_reason,
        'drained', true,
        'in_flight', json_build_object('total', (SELECT count(*) FROM jobs WHERE status IN ('claimed','provisioning','running'))),
        'effect_pending_attempts', (SELECT count(*) FROM job_attempt_effects WHERE status='effect_pending'),
        'unknown_effect_attempts', (SELECT count(*) FROM job_attempt_effects WHERE status='unknown'))
        FROM global_settings WHERE id='global'`);
      return JSON.parse(value);
    },
    async forcePaused() {
      // Never overwrite a concurrent operator's pause/resume decision.
      assertDrained(await adapter.recoveryClaims());
    },
    async configure(target) {
      let contents = await readFile(envPath, 'utf8'); parseValues(contents);
      for (const [key, value] of Object.entries(imageValues(target))) contents = contents.replace(new RegExp(`^${key}=.*$`, 'gm'), `${key}=${value}`);
      parseValues(contents); await atomic(envPath, contents);
    },
    start: async () => { dc(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', ...services]); },
    async verify(target) {
      // Compose health only proves HTTP 200. Scheduler runtime-image/gateway
      // warmup is asynchronous and can still be preparing after compose --wait.
      const deadline = Date.now() + (options.readyTimeoutMs ?? 180_000);
      while (true) {
        try {
          const health = await request('/health', undefined, Math.min(15_000, Math.max(1, deadline - Date.now())));
          if (health.ok === true && health.ready === true && health.version === target.version) break;
        } catch { /* Retry bounded transport/HTTP errors during service restart. */ }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('health/version readiness timeout; claims remain paused');
        await new Promise(resolve => setTimeout(resolve, Math.min(options.readyIntervalMs ?? 2000, remaining)));
      }
      if (Number(sql("SELECT version FROM schema_meta WHERE id='global'")) !== (target.schema_version ?? target.schema)) throw new Error('schema verification failed');
      verifyImages(target);
      dc(['exec', '-T', 'web', 'node', '-e', "fetch('http://127.0.0.1:8080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]);
      if (options.webUrl) {
        const url = new URL(options.webUrl);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('Web URL must use HTTPS or loopback HTTP');
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error('external Web HTTP verification failed');
      }
      assertDrained(await adapter.claims());
    },
  };
  return adapter;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--reset-role-identity') {options.resetRoleIdentity = true; i -= 1; continue;}
    const key = { '--version': 'version', '--to': 'version', '--api': 'api', '--web-url': 'webUrl', '--web': 'webUrl', '--compose-file': 'composeFiles', '--approve-plan-hash': 'approvedPlanHash', '--nodes': 'nodes' }[args[i]];
    if (!key || !args[i + 1]) throw new Error('usage: check|apply|rollback [--to vX.Y.Z] [--api URL] [--web-url URL] [--compose-file FILE ...]');
    if (key === 'composeFiles') (options[key] ??= []).push(args[i + 1]); else options[key] = args[i + 1];
  }
  try {
    const {runHostMaintenance} = await import('./platform-upgrade-maintenance-host.mjs');
    console.log(JSON.stringify(await runHostMaintenance(action, options), null, 2));
  }
  catch (error) { if (error.preflight) console.error(JSON.stringify(error.preflight, null, 2)); console.error(`[upgrade] ${error.message}; interrupted upgrades retain pause and recovery state in deploy/.upgrade`); process.exitCode = 1; }
}
