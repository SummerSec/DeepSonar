// Only the opt-in maintenance rehearsal imports this fixture; no production CLI seam.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectFixtureRef, services, imageKeys} from './platform-upgrade-compose.fixture.mjs';
export {inspectFixtureRef, services, imageKeys};

export function docker(args, input) {
  const result = spawnSync('docker', args, {input, maxBuffer: 512 * 1024 * 1024, timeout: 600_000});
  if (result.error || result.status !== 0) throw new Error(`maintenance fixture docker ${args[0]} failed (${result.status}); raw output suppressed`);
  return result.stdout.toString().trim();
}
export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.match(config.registry, /^127\.0\.0\.1:[1-9][0-9]{1,4}$/);
  assert.equal(config.oldSchema, 59, 'old image must bootstrap the real v59 baseline');
  assert.ok(Number.isSafeInteger(config.newSchema) && config.newSchema > config.oldSchema);
  for (const version of [config.oldVersion, config.newVersion]) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    for (const service of services) {
      const ref = config.versions?.[version]?.[service];
      assert.ok(ref?.startsWith(`${config.registry}/summersec/deepsonar-${service}@sha256:`));
      assert.match(ref, /@sha256:[a-f0-9]{64}$/);
    }
  }
  for (const service of services) assert.notEqual(config.versions[config.oldVersion][service], config.versions[config.newVersion][service]);
  return config;
}
export function target(config, old = false) {
  const version = old ? config.oldVersion : config.newVersion;
  return {version, schema_version: old ? config.oldSchema : config.newSchema,
    values: {DEEPSONAR_VERSION: version, ...Object.fromEntries(services.map(service => [imageKeys[service], config.versions[version][service]]))}};
}
export function parseValues(config) {
  return contents => {
    const values = {};
    for (const key of ['DEEPSONAR_VERSION', ...Object.values(imageKeys)]) {
      const lines = contents.split(/\r?\n/).filter(line => new RegExp(`^\\s*(?:export\\s+)?${key}(?:\\s*[=:]|\\s*$)`).test(line));
      assert.equal(lines.length, 1); assert.ok(lines[0].startsWith(`${key}=`)); values[key] = lines[0].slice(key.length + 1);
    }
    assert.ok([config.oldVersion, config.newVersion].includes(values.DEEPSONAR_VERSION));
    for (const service of services) assert.equal(values[imageKeys[service]], config.versions[values.DEEPSONAR_VERSION][service]);
    return values;
  };
}
export async function createFixture(config, output, name) {
  assert.match(name, /^[a-z0-9-]+$/);
  const project = `pr747-maint-${name}-${randomUUID().slice(0, 8)}`;
  const directory = join(output, project); await mkdir(directory, {recursive: true, mode: 0o700});
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const token = randomBytes(32).toString('hex'), password = randomBytes(32).toString('hex');
  const env = {...target(config, true).values, POSTGRES_IMAGE: config.postgresImage ?? 'postgres:16-alpine', POSTGRES_PASSWORD: password,
    DEEPSONAR_DATABASE_USER: 'deepsonar', DEEPSONAR_DATABASE_PASSWORD: password, DEEPSONAR_DATABASE_NAME: 'deepsonar', DEEPSONAR_ADMIN_TOKEN: token,
    DEEPSONAR_MASTER_KEY: randomBytes(32).toString('hex'), TEST_WEB_PORT: String(port)};
  await writeFile(join(directory, '.env'), Object.entries(env).map(([key,value]) => `${key}=${value}`).join('\n') + '\n', {mode: 0o600});
  await writeFile(join(directory, 'compose.yml'), composeFixture, {mode: 0o600});
  return {project, directory, api: `http://127.0.0.1:${port}/api/`, token};
}
export function dc(fixture, args, input) {
  assert.match(fixture.project, /^pr747-maint-[a-z0-9-]+$/);
  return docker(['compose', '-p', fixture.project, '--env-file', join(fixture.directory,'.env'), '-f', join(fixture.directory,'compose.yml'), ...args], input);
}
export function query(fixture, sql, {role = 'deepsonar', database = 'deepsonar'} = {}) {
  assert.match(role, /^[a-z][a-z0-9_]{0,62}$/); assert.match(database, /^[a-z][a-z0-9_]{0,62}$/);
  return dc(fixture, ['exec','-T','postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',role,'-d',database], sql);
}
export async function request(fixture, path, body) {
  return fetch(new URL(path, fixture.api), {method: body === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${fixture.token}`, 'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000)});
}
export async function health(fixture, version, preparing = false) {
  const deadline = Date.now()+180_000;
  while (Date.now()<deadline) {
    try {
      const response=await request(fixture,'health'), data=await response.json();
      if (response.ok && data.version===version && (preparing ? data.maintenance_ready===true && data.ready===false : data.ready===true)) return data;
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('maintenance fixture health timeout');
}

const composeFixture = `services:
  postgres:
    image: \${POSTGRES_IMAGE}
    environment:
      POSTGRES_USER: deepsonar
      POSTGRES_DB: deepsonar
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes: ["postgres_data:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U deepsonar -d deepsonar"]
      interval: 2s
      timeout: 3s
      retries: 30
  scheduler:
    image: \${DEEPSONAR_SCHEDULER_IMAGE}
    environment:
      DATABASE_URL: postgres://\${DEEPSONAR_DATABASE_USER:-deepsonar}:\${DEEPSONAR_DATABASE_PASSWORD:-\${POSTGRES_PASSWORD}}@postgres:5432/\${DEEPSONAR_DATABASE_NAME:-deepsonar}
      SCHEDULER_HOST: 0.0.0.0
      SCHEDULER_PORT: "3100"
      DEEPSONAR_AUTH_REQUIRED: "true"
      DEEPSONAR_ADMIN_TOKEN: \${DEEPSONAR_ADMIN_TOKEN}
      DEEPSONAR_MASTER_KEY: \${DEEPSONAR_MASTER_KEY}
      DEEPSONAR_VERSION: \${DEEPSONAR_VERSION}
      DEEPSONAR_UPGRADE_GENERATION: \${DEEPSONAR_UPGRADE_GENERATION:-}
      AGENT_MODE: fake
      BLOB_STORE: fs
      BLOB_DIR: /app/data/blobs
    volumes: ["blob_data:/app/data"]
    depends_on:
      postgres: {condition: service_healthy}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 60
  image-admission:
    image: \${DEEPSONAR_IMAGE_ADMISSION_IMAGE}
    environment:
      DATABASE_URL: postgres://\${DEEPSONAR_DATABASE_USER:-deepsonar}:\${DEEPSONAR_DATABASE_PASSWORD:-\${POSTGRES_PASSWORD}}@postgres:5432/\${DEEPSONAR_DATABASE_NAME:-deepsonar}
      DEEPSONAR_UPGRADE_GENERATION: \${DEEPSONAR_UPGRADE_GENERATION:-}
      DEEPSONAR_VERSION: \${DEEPSONAR_VERSION}
      DEEPSONAR_MASTER_KEY: \${DEEPSONAR_MASTER_KEY}
    depends_on:
      scheduler: {condition: service_healthy}
    # Intentionally no Docker socket: this test does not run image scans.
  web:
    image: \${DEEPSONAR_WEB_IMAGE}
    ports: ["127.0.0.1:\${TEST_WEB_PORT}:8080"]
    environment:
      HOST: 0.0.0.0
      PORT: "8080"
      SCHEDULER_URL: http://scheduler:3100
    depends_on:
      scheduler: {condition: service_healthy}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 60
volumes:
  postgres_data: {}
  blob_data: {}
`;
