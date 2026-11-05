import {spawnSync} from 'node:child_process';
import {resolve, join, basename} from 'node:path';
import {readFileSync} from 'node:fs';
import {sha256} from '../deploy/platform-upgrade-signature-contract.mjs';
import {fileURLToPath} from 'node:url';
// gh release view errors are not proof of absence. Only an authenticated API 404
// permits create; an existing draft/prerelease requires operator reconciliation.
export function publicationState(version, repo, run = (args) => spawnSync('gh', args, {encoding: 'utf8'}), expectedAssets) {
  if (repo !== 'SummerSec/DeepSonar' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw Error('release_state_identity_invalid');
  const result = run(['api', '--hostname', 'github.com', '--include', `repos/${repo}/releases/tags/v${version}`]);
  const output = String(result.stdout ?? '').replaceAll('\r\n', '\n');
  const status = /^HTTP\/\S+ (\d{3})\b/.exec(output)?.[1];
  if (status === '404' && result.status !== 0) return 'missing';
  if (status !== '200' || result.status !== 0) throw Error('release_state_lookup_failed');
  const release = JSON.parse(output.slice(output.indexOf('\n\n') + 2));
  if (release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false) throw Error('release_state_conflict');
  if (expectedAssets) {
    for (const [name, digest] of Object.entries(expectedAssets)) {
      const assets = release.assets?.filter(asset => asset.name === name) ?? [];
      if (assets.length !== 1 || assets[0].state !== 'uploaded' || assets[0].digest !== digest) throw Error('release_assets_conflict');
    }
  }
  return 'existing';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [payload, signatures] = process.argv.slice(2);
    const version = process.env.VERSION;
    const files = [join(payload, `deepsonar-reverse-evidence-${version}.tar.gz`),
      join(payload, `deepsonar-management-skill-${version}.tar.gz`), join(payload, 'deploy/runtime-image-registry.json'),
      join(payload, 'runtime-image-registry-v2.json'), join(signatures, 'platform-signature-evidence.json')];
    const expected = Object.fromEntries(files.map(file => [basename(file), `sha256:${sha256(readFileSync(file))}`]));
    console.log(publicationState(version, process.env.GITHUB_REPOSITORY, undefined, expected));
  }
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
