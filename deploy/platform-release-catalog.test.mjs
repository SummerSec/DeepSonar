// #842: the release catalog publishes several registry channels per platform
// image, but an upgrade must keep the channel the deployment already uses.
// Switching registry is an explicit operator decision, never an upgrade side
// effect. These tests pin the resolution policy itself; the host CLI write path
// is covered in deploy/platform-upgrade.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_IMAGE_CHANNEL_NAMES,
  PLATFORM_IMAGE_CHANNELS,
  PLATFORM_IMAGE_KEYS,
  isPlatformImageRef,
  platformImageKey,
  platformImageRefPattern,
  resolvePlatformImageValues,
} from './platform-release-catalog.mjs';
import { resolveReleaseTarget } from './platform-upgrade-host.mjs';

const digest = letter => `sha256:${letter.repeat(64)}`;
const ACR = PLATFORM_IMAGE_CHANNELS['aliyun-acr'];
const githubRef = service => `ghcr.io/summersec/deepsonar-${service}@${digest('a')}`;
const acrRef = service => `${ACR.host}/${ACR.namespace}/deepsonar-${service}@${digest('b')}`;
const dockerhubRef = service => `docker.io/sumsec/deepsonar-${service}@${digest('c')}`;

function catalogPlatform(refsByChannel, version = '0.6.3') {
  return {
    version,
    schema_version: 65,
    images: Object.fromEntries(PLATFORM_IMAGE_KEYS.map(service => [service, {
      digest: digest('a'),
      registry_refs: Object.fromEntries(Object.entries(refsByChannel).map(([channel, make]) => [channel, make(service)])),
    }])),
  };
}

const envFile = (refsByService) => [
  'DEEPSONAR_VERSION=0.6.2',
  ...PLATFORM_IMAGE_KEYS.map(service => `${platformImageKey(service)}=${refsByService(service)}`),
].join('\n') + '\n';

const valuesOf = refsByService => Object.fromEntries([
  ['DEEPSONAR_VERSION', '0.6.2'],
  ...PLATFORM_IMAGE_KEYS.map(service => [platformImageKey(service), refsByService(service)]),
]);

test('channel identity stays on the official hosts and Docker Hub uses the sumsec namespace', () => {
  assert.deepEqual([...PLATFORM_IMAGE_CHANNEL_NAMES], ['github', 'dockerhub', 'aliyun-acr']);
  assert.equal(PLATFORM_IMAGE_CHANNELS.github.namespace, 'summersec');
  assert.equal(PLATFORM_IMAGE_CHANNELS.dockerhub.host, 'docker.io');
  assert.equal(PLATFORM_IMAGE_CHANNELS.dockerhub.namespace, 'sumsec');
  assert.equal(PLATFORM_IMAGE_CHANNELS['aliyun-acr'].namespace, 'summersec');
});

test('official ref pattern accepts every published channel and rejects copies outside policy', () => {
  for (const service of PLATFORM_IMAGE_KEYS) {
    assert.ok(isPlatformImageRef(service, githubRef(service)), service);
    assert.ok(isPlatformImageRef(service, acrRef(service)), service);
    assert.ok(isPlatformImageRef(service, dockerhubRef(service)), service);
    // Wrong repository for the service, mutable tag, wrong namespace, unknown host.
    assert.equal(isPlatformImageRef('web', githubRef('scheduler')), false);
    assert.equal(isPlatformImageRef(service, `ghcr.io/summersec/deepsonar-${service}:0.6.3`), false);
    assert.equal(isPlatformImageRef(service, `docker.io/summersec/deepsonar-${service}@${digest('a')}`), false);
    assert.equal(isPlatformImageRef(service, `127.0.0.1:55000/summersec/deepsonar-${service}@${digest('a')}`), false);
    assert.equal(isPlatformImageRef(service, `ghcr.io/summersec/deepsonar-${service}@sha256:${'A'.repeat(64)}`), false);
  }
  assert.throws(() => platformImageRefPattern('unknown-service'), { code: 'UPGRADE_REGISTRY_REF_INVALID' });
});

test('an Aliyun ACR deployment keeps pulling from Aliyun ACR after an upgrade', () => {
  const target = catalogPlatform({github: githubRef, 'aliyun-acr': acrRef});
  const values = resolvePlatformImageValues(target, valuesOf(acrRef));
  assert.equal(values.DEEPSONAR_VERSION, '0.6.3');
  for (const service of PLATFORM_IMAGE_KEYS) assert.equal(values[platformImageKey(service)], acrRef(service));
});

test('a Docker Hub deployment resolves the dockerhub channel (sumsec namespace regression)', () => {
  const target = catalogPlatform({github: githubRef, dockerhub: dockerhubRef});
  const values = resolvePlatformImageValues(target, valuesOf(dockerhubRef));
  for (const service of PLATFORM_IMAGE_KEYS) assert.equal(values[platformImageKey(service)], dockerhubRef(service));
});

test('a GitHub deployment keeps ghcr.io references', () => {
  const target = catalogPlatform({github: githubRef, 'aliyun-acr': acrRef});
  const values = resolvePlatformImageValues(target, valuesOf(githubRef));
  for (const service of PLATFORM_IMAGE_KEYS) assert.equal(values[platformImageKey(service)], githubRef(service));
});

test('a channel missing from the release catalog fails closed instead of falling back to GitHub', () => {
  const target = catalogPlatform({github: githubRef});
  assert.throws(() => resolvePlatformImageValues(target, valuesOf(acrRef)), {
    code: 'UPGRADE_REGISTRY_CHANNEL_UNRESOLVED',
  });
});

test('unusable current values fail closed instead of guessing', () => {
  const target = catalogPlatform({github: githubRef, 'aliyun-acr': acrRef});
  assert.throws(() => resolvePlatformImageValues(target, valuesOf(() => '')).UPGRADE_REGISTRY_CHANNEL_UNRESOLVED, {
    code: 'UPGRADE_REGISTRY_CHANNEL_UNRESOLVED',
  });
  assert.throws(() => resolvePlatformImageValues(target, {}), { code: 'UPGRADE_REGISTRY_CHANNEL_UNRESOLVED' });
});

test('an explicit channel is the only way to change registry and must be published for every service', () => {
  const target = catalogPlatform({github: githubRef, 'aliyun-acr': acrRef});
  const migrated = resolvePlatformImageValues(target, valuesOf(acrRef), { channel: 'github' });
  for (const service of PLATFORM_IMAGE_KEYS) assert.equal(migrated[platformImageKey(service)], githubRef(service));

  assert.throws(() => resolvePlatformImageValues(target, valuesOf(acrRef), { channel: 'dockerhub' }), {
    code: 'UPGRADE_REGISTRY_CHANNEL_UNRESOLVED',
  });
  assert.throws(() => resolvePlatformImageValues(target, valuesOf(acrRef), { channel: 'summersec' }), {
    code: 'UPGRADE_REGISTRY_CHANNEL_INVALID',
  });

  // A partial channel switch must not ship three services across two registries.
  const partial = catalogPlatform({github: githubRef, 'aliyun-acr': acrRef});
  delete partial.images.web.registry_refs['aliyun-acr'];
  assert.throws(() => resolvePlatformImageValues(partial, valuesOf(acrRef), { channel: 'aliyun-acr' }), {
    code: 'UPGRADE_REGISTRY_CHANNEL_UNRESOLVED',
  });
});

test('ambiguous catalogs and malformed releases fail closed', () => {
  const ambiguous = catalogPlatform({github: githubRef, 'aliyun-acr': acrRef});
  // Two channels publishing the same repository cannot be distinguished.
  ambiguous.images.scheduler.registry_refs['aliyun-acr'] = githubRef('scheduler');
  assert.throws(() => resolvePlatformImageValues(ambiguous, valuesOf(githubRef)), {
    code: 'UPGRADE_REGISTRY_CHANNEL_UNRESOLVED',
  });

  const outOfPolicy = catalogPlatform({github: githubRef, 'aliyun-acr': acrRef});
  outOfPolicy.images.web.registry_refs['aliyun-acr'] = `127.0.0.1:55000/summersec/deepsonar-web@${digest('a')}`;
  assert.throws(() => resolvePlatformImageValues(outOfPolicy, valuesOf(acrRef), { channel: 'aliyun-acr' }), {
    code: 'UPGRADE_REGISTRY_REF_INVALID',
  });

  assert.throws(() => resolvePlatformImageValues({ version: 'v0.6.3' }, valuesOf(githubRef)), {
    code: 'UPGRADE_TARGET_INVALID',
  });
  assert.throws(() => resolvePlatformImageValues({ version: '0.6.3' }, valuesOf(githubRef)), {
    code: 'UPGRADE_TARGET_IMAGES_INVALID',
  });
});

test('resolveReleaseTarget reads the deployment .env and preserves its registry channel', () => {
  const target = catalogPlatform({github: githubRef, 'aliyun-acr': acrRef});
  const resolved = resolveReleaseTarget(target, envFile(acrRef));
  for (const service of PLATFORM_IMAGE_KEYS) assert.equal(resolved.values[platformImageKey(service)], acrRef(service));
  assert.equal(resolved.values.DEEPSONAR_VERSION, '0.6.3');
  // The catalog object itself stays free of deployment values.
  assert.equal(target.values, undefined);

  const migrated = resolveReleaseTarget(target, envFile(acrRef), { channel: 'github' });
  for (const service of PLATFORM_IMAGE_KEYS) assert.equal(migrated.values[platformImageKey(service)], githubRef(service));
});

test('resolveReleaseTarget rejects a deployment that is not on an official registry', () => {
  const target = catalogPlatform({github: githubRef});
  const local = envFile(service => `127.0.0.1:55000/summersec/deepsonar-${service}@${digest('a')}`);
  assert.throws(() => resolveReleaseTarget(target, local), /official registry/);
});