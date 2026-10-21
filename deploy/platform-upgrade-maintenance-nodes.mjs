import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createManagedNodeRunner, validateNodeInventory} from './platform-upgrade-nodes.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
export async function loadManagedInventory(path) {
  if (!path) return {nodes: []};
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return {nodes: validateNodeInventory(raw).nodes};
}
export function maintenanceNodes({inventory, registeredWorkerIds, transport, run, commandEnv, sshOptions}) {
  const runner = createManagedNodeRunner({inventory, registeredWorkerIds, transport, sshOptions});
  return {
    bindingHash: runner.bindingHash,
    async fence(generation) {for (const node of runner.nodes) await runner.fence({id: node.id, generation});},
    async prepare({generation, target, values, saved}) {
      let workerScript, workerContract;
      if (runner.nodes.some(node => node.kind === 'worker')) {
        const output = run(['run', '--rm', '--network=none', '--read-only', '--entrypoint=node', values.DEEPSONAR_SCHEDULER_IMAGE, '-e', "const fs=require('fs');console.log(JSON.stringify({script:fs.readFileSync('/app/deploy/worker-register.mjs','utf8'),contract:fs.readFileSync('/app/deploy/worker-register-contract.mjs','utf8')}))"], undefined, commandEnv);
        ({script: workerScript, contract: workerContract} = JSON.parse(output.toString()));
        if (typeof workerScript !== 'string' || typeof workerContract !== 'string') throw new Error('target worker scripts unavailable');
      }
      for (const node of runner.nodes) {
        const common = {id: node.id, generation, version: target.version};
        if (node.kind === 'worker') await runner.prepareWorker({...common, generationToken: saved.workerToken,
          workerScript, workerContract, workerScriptSha256: hash(workerScript), workerContractSha256: hash(workerContract)});
        else await runner.prepareControl({...common, images: {scheduler: values.DEEPSONAR_SCHEDULER_IMAGE, web: values.DEEPSONAR_WEB_IMAGE, 'image-admission': values.DEEPSONAR_IMAGE_ADMISSION_IMAGE},
          runtimeRole: saved.runtime.role, databaseIdentity: {...saved.runtime, database: saved.candidateDatabase}});
      }
    },
    async verify({generation, target, active}) {
      const evidence = [];
      for (const node of runner.nodes) {
        const result = await runner.inspect({id: node.id, generation});
        if (result.version !== target.version) throw new Error('managed node target version mismatch');
        if (node.kind === 'control') {
          if (active ? result.health?.ready !== true : result.health?.maintenance_ready !== true || result.health?.maintenance !== true || result.health?.upgrade_generation !== generation) throw new Error('managed control node is not ready in the expected phase');
        }
        evidence.push(result);
      }
      return evidence;
    },
  };
}
