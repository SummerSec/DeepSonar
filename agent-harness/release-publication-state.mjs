import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// gh release view errors are not proof of absence. Only an authenticated API 404
// permits create; an existing draft/prerelease requires operator reconciliation.
export function publicationState(version, repo, run = (args) => spawnSync('gh', args, {encoding: 'utf8'})) {
  if (repo !== 'SummerSec/DeepSonar' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw Error('release_state_identity_invalid');
  const result = run(['api', '--hostname', 'github.com', '--include', `repos/${repo}/releases/tags/v${version}`]);
  const output = String(result.stdout ?? '').replaceAll('\r\n', '\n');
  const status = /^HTTP\/\S+ (\d{3})\b/.exec(output)?.[1];
  if (status === '404' && result.status !== 0) return 'missing';
  if (status !== '200' || result.status !== 0) throw Error('release_state_lookup_failed');
  const release = JSON.parse(output.slice(output.indexOf('\n\n') + 2));
  if (release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false) throw Error('release_state_conflict');
  return 'existing';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(publicationState(process.env.VERSION, process.env.GITHUB_REPOSITORY));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
