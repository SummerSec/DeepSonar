// Explicit integration-only fixtures. Not imported by the production upgrade CLI.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { hostAdapter } from './platform-upgrade-host.mjs';

export const services = ['scheduler', 'web', 'image-admission'];
export const imageKeys = Object.fromEntries(services.map(name => [name, `DEEPSONAR_${name.replaceAll('-', '_').toUpperCase()}_IMAGE`]));
export function docker(args, input) {
  const result = spawnSync('docker', args, {input, maxBuffer: 512 * 1024 * 1024, timeout: 600_000});
  if (result.error || result.status !== 0) throw new Error(`fixture docker ${args[0]} failed (${result.status}): ${String(result.stderr).slice(-2000)}`);
  return result.stdout.toString().trim();
}

export async function loadFixtureConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.match(config.registry, /^127\.0\.0\.1:[1-9][0-9]{1,4}$/);
  assert.equal(config.schemaVersion, 59, 'these two source builds must use schema 59');
  for (const version of ['0.0.1', '0.0.2']) for (const service of services) {
    const ref = config.versions?.[version]?.[service];
    assert.ok(ref?.startsWith(`${config.registry}/summersec/deepsonar-${service}@sha256:`), `wrong fixture repository: ${service}`);
    assert.match(ref, /@sha256:[0-9a-f]{64}$/);
  }
  for (const service of services) assert.notEqual(config.versions['0.0.1'][service], config.versions['0.0.2'][service], `${service} needs two distinct real image digests`);
  return config;
}

// Verify bytes served by the real local registry, including native child/config
// digests. No official-channel provenance or second architecture is fabricated.
export async function inspectFixtureRef(config, ref) {
  const [repository, digest] = ref.slice(config.registry.length + 1).split('@');
  const get = async (kind, expected) => {
    const response = await fetch(`http://${config.registry}/v2/${repository}/${kind}/${expected}`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'},
    });
    assert.equal(response.status, 200, `registry ${kind} ${expected}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, expected, 'registry content digest mismatch');
    return JSON.parse(bytes.toString());
  };
  const architecture = docker(['version', '--format', '{{.Server.Arch}}']);
  const top = await get('manifests', digest);
  let manifest = top;
  if (Array.isArray(top.manifests)) {
    const children = top.manifests.filter(item => item.platform?.os === 'linux' && item.platform?.architecture === architecture);
    assert.equal(children.length, 1, 'one native runnable child required');
    manifest = await get('manifests', children[0].digest);
  }
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(Array.isArray(manifest.layers) && manifest.layers.length > 0);
  const imageConfig = await get('blobs', manifest.config.digest);
  assert.equal(imageConfig.os, 'linux'); assert.equal(imageConfig.architecture, architecture);
  return {ref, digest, architecture, configDigest: manifest.config.digest};
}

export function fixtureParser(config) {
  return contents => {
    const values = {};
    for (const key of ['DEEPSONAR_VERSION', ...Object.values(imageKeys)]) {
      const assignments = contents.split(/\r?\n/).filter(line => new RegExp(`^\\s*(?:export\\s+)?${key}(?:\\s*[=:]|\\s*$)`).test(line));
      assert.equal(assignments.length, 1, `one canonical ${key} required`);
      assert.ok(assignments[0].startsWith(`${key}=`));
      values[key] = assignments[0].slice(key.length + 1);
    }
    assert.ok(['0.0.1', '0.0.2'].includes(values.DEEPSONAR_VERSION));
    for (const service of services) assert.ok(Object.values(config.versions).some(images => images[service] === values[imageKeys[service]]), 'fixture ref must belong to the supplied immutable inventory');
    assert.doesNotMatch(contents, /^\s*(?:export\s+)?DEEPSONAR_IMAGE_TAG\s*=/m);
    return values;
  };
}

export function fixtureTarget(config, version = '0.0.2') {
  return {version, schema_version: config.schemaVersion, values: {
    DEEPSONAR_VERSION: version, ...Object.fromEntries(services.map(service => [imageKeys[service], config.versions[version][service]])),
  }};
}

export function fixtureAdapter(config, fixture, extra = {}) {
  return hostAdapter({
    directory: fixture.directory, projectName: fixture.project, composeFiles: ['compose.yml'],
    api: fixture.api, readyTimeoutMs: 180_000,
    parsePlatformValues: fixtureParser(config),
    releaseProvider: async () => {
      for (const ref of Object.values(config.versions['0.0.2'])) await inspectFixtureRef(config, ref);
      return fixtureTarget(config);
    },
    ...extra,
  });
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function createFixture(config, output, name) {
  const project = `pr747-upgrade-${name}-${randomUUID().slice(0, 8)}`;
  const directory = join(output, project); await mkdir(directory, {recursive: true, mode: 0o700});
  const port = await freePort(), token = randomBytes(32).toString('hex');
  const values = fixtureTarget(config, '0.0.1').values;
  const env = { ...values, POSTGRES_IMAGE: config.postgresImage ?? 'postgres:16-alpine', POSTGRES_PASSWORD: randomBytes(24).toString('hex'), DEEPSONAR_ADMIN_TOKEN: token, DEEPSONAR_MASTER_KEY: randomBytes(32).toString('hex'), TEST_WEB_PORT: String(port) };
  await writeFile(join(directory, '.env'), `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {mode: 0o600});
  await writeFile(join(directory, 'compose.yml'), composeFixture, {mode: 0o600});
  return {project, directory, api: `http://127.0.0.1:${port}/api/`, token};
}
export const dc = (fixture, args, input) => docker(['compose', '-p', fixture.project, '--env-file', join(fixture.directory, '.env'), '-f', join(fixture.directory, 'compose.yml'), ...args], input);
export const sql = (fixture, query) => dc(fixture, ['exec', '-T', 'postgres', 'psql', '-U', 'deepsonar', '-d', 'deepsonar', '-v', 'ON_ERROR_STOP=1', '-Atc', query]);
export async function api(fixture, path, body) {
  const response = await fetch(new URL(path, fixture.api), {method: body ? 'POST' : 'GET', headers: {Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000)});
  assert.equal(response.status, 200, `${path} status`); return response.json();
}
export async function waitReady(fixture, version = '0.0.1') {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { const health = await api(fixture, 'health'); if (health.ok === true && health.ready === true && health.version === version) return health; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('fixture readiness timeout');
}
export function containerEvidence(config, fixture, version) {
  return Object.fromEntries(services.map(service => {
    const id = dc(fixture, ['ps', '-q', service]); assert.ok(id && !id.includes('\n'));
    const [container] = JSON.parse(docker(['inspect', id]));
    const expected = config.versions[version][service];
    assert.equal(container.Config.Image, expected);
    const [image] = JSON.parse(docker(['image', 'inspect', expected]));
    assert.equal(container.Image, image.Id, 'actual image config digest must match the pulled immutable image');
    assert.equal(container.State.Running, true);
    assert.equal(container.Config.Labels['com.docker.compose.project'], fixture.project);
    return [service, {container: id, ref: expected, imageId: container.Image, startedAt: container.State.StartedAt}];
  }));
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
      DATABASE_URL: postgres://deepsonar:\${POSTGRES_PASSWORD}@postgres:5432/deepsonar
      SCHEDULER_HOST: 0.0.0.0
      SCHEDULER_PORT: "3100"
      DEEPSONAR_AUTH_REQUIRED: "true"
      DEEPSONAR_ADMIN_TOKEN: \${DEEPSONAR_ADMIN_TOKEN}
      DEEPSONAR_MASTER_KEY: \${DEEPSONAR_MASTER_KEY}
      DEEPSONAR_VERSION: \${DEEPSONAR_VERSION}
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
      DATABASE_URL: postgres://deepsonar:\${POSTGRES_PASSWORD}@postgres:5432/deepsonar
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
