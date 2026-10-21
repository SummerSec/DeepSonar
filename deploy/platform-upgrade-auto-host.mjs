import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {hostAdapter, platformValues} from './platform-upgrade-host.mjs';
import {maintenanceHostAdapter} from './platform-upgrade-maintenance-host.mjs';
import {createMaintenanceTransport, durablePrivateWrite, readPrivateJson} from './platform-upgrade-maintenance-transport.mjs';
import {AUTO_POLICY_SCHEMA, validateAutoPolicy, inMaintenanceWindow, autoError} from './platform-upgrade-auto-policy.mjs';
import {runAutomaticUpgrade} from './platform-upgrade-auto.mjs';

export async function runHostAutomatic(options = {}) {
  if (options.version || options.approvedPlanHash || options.resetRoleIdentity) throw autoError('AUTO_MANUAL_OPTIONS_FORBIDDEN');
  const policy = validateAutoPolicy(options.policy ? await readPrivateJson(resolve(options.policy)) : {schema: AUTO_POLICY_SCHEMA, enabled: false});
  if (!policy.enabled) return {status: 'not_started', reason: 'policy_disabled'};
  const root = resolve(options.directory ?? dirname(fileURLToPath(import.meta.url)));
  const recovery = resolve(root, '.upgrade'), receiptPath = resolve(recovery, 'auto-authorization.json');
  // A scheduled check outside the window does not even touch Docker.
  if (!inMaintenanceWindow(policy) && !await readPrivateJson(resolve(recovery, 'maintenance.json'))) return {status: 'not_started', reason: 'outside_maintenance_window'};
  const io = maintenanceHostAdapter(options), legacy = hostAdapter(options);
  const composeFiles = (options.composeFiles ?? ['docker-compose.prod.yml', 'docker-compose.real.yml', 'docker-compose.opensandbox.prod.yml']).map(path => resolve(root, path));
  const compose = ['compose', '-p', options.projectName ?? 'deepsonar', '--env-file', resolve(root, '.env'), ...composeFiles.flatMap(path => ['-f', path])];
  const {dc} = createMaintenanceTransport({compose, commandEnv: {...process.env}, run: options.run});
  const current = async () => {
    const contents = await readFile(resolve(root, '.env'), 'utf8');
    const values = (options.parsePlatformValues ?? platformValues)(contents);
    const health = JSON.parse(dc(['exec', '-T', 'scheduler', 'node', '-e', "fetch('http://127.0.0.1:'+(process.env.SCHEDULER_PORT||'3100')+'/health').then(async r=>{if(!r.ok)throw Error();console.log(await r.text())}).catch(()=>process.exit(1))"]).toString());
    if (health.ok !== true || health.ready !== true || health.maintenance === true || health.version !== values.DEEPSONAR_VERSION) throw autoError('AUTO_SOURCE_NOT_HEALTHY');
    return {version: health.version, environmentHash: createHash('sha256').update(contents).digest('hex')};
  };
  return io.lock(async () => runAutomaticUpgrade({...io, current,
    readAuthorization: () => readPrivateJson(receiptPath),
    writeAuthorization: value => durablePrivateWrite(receiptPath, JSON.stringify(value)),
    discoverTarget: () => legacy.release(), pull: target => legacy.pull(target),
    verifySignatures: async (target, signaturePolicy) => {
      const {verifyPlatformSignatures} = await import('./platform-upgrade-signature.mjs');
      return verifyPlatformSignatures({target: {version: target.version, commit_sha: target.commit_sha, schema_version: target.schema_version,
        images: Object.fromEntries(['scheduler', 'web', 'image-admission'].map(service => [service, target.images[service].registry_refs.github]))}, policy: signaturePolicy});
    },
  }, {policy}));
}
