// Isolated real-Scheduler multinode rehearsal. No synthetic control-plane health.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startLoopbackSshFixture} from './platform-upgrade-nodes-ssh.fixture.mjs';
import {docker, dc, health} from './platform-upgrade-maintenance.fixture.mjs';
const NODE_IMAGE = 'node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const envOf = row => Object.fromEntries(row.Config.Env.map(line => {const at = line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
const escapeEnvironment = env => Object.fromEntries(Object.entries(env).map(([key,value]) => [key,String(value).replaceAll('$',()=> '$$')]));
const inspect = id => JSON.parse(docker(['inspect',id]))[0];
const command = "let raw='';for await(const b of process.stdin)raw+=b;const p=JSON.parse(raw);const r=await fetch(p.url,{method:p.body?'POST':'GET',headers:{'content-type':'application/json',...(p.token?{authorization:'Bearer '+p.token}:{})},body:p.body?JSON.stringify(p.body):undefined});console.log(JSON.stringify({status:r.status,data:await r.json()}));";

/** Call after the root fixture is healthy, before planning. Caller must close before root down. */
export async function createMaintenanceMultinodeFixture(config, root) {
  assert.match(root.project, /^pr747-maint-[a-z0-9-]+$/);
  const ssh = await startLoopbackSshFixture();
  const projects = []; const workerId = `worker-${root.project.slice(-8)}`;
  const bootstrap = randomBytes(32).toString('hex'), apiKey = randomBytes(32).toString('hex');
  let oldNodeToken;
  const controlProject = `pr747-control-${root.project.slice(-8)}`, workerProject = `pr747-worker-${root.project.slice(-8)}`;
  const endpoint = `${workerProject}-opensandbox-1:8080`;
  const rootSchedulerId = () => dc(root,['ps','-q','scheduler']);
  async function close() {
    const failures=[];
    for (const args of [...projects].reverse()) try {docker([...args,'down','--volumes','--remove-orphans']);} catch {failures.push('multinode Compose cleanup failed');}
    await ssh.close();
    assert.deepEqual(failures,[]);
  }
  try {
    // Persist only in this fixture's private files; never pass bootstrap secrets in argv.
    await writeFile(join(root.directory,'.env'), (await readFile(join(root.directory,'.env'),'utf8')) + `DEEPSONAR_WORKER_BOOTSTRAP_TOKEN=${bootstrap}\n`, {mode:0o600});
    const sourceCompose = await readFile(join(root.directory,'compose.yml'),'utf8');
    assert.equal(sourceCompose.split('      AGENT_MODE: fake').length,2);
    await writeFile(join(root.directory,'compose.yml'), sourceCompose.replace('      AGENT_MODE: fake', `      AGENT_MODE: fake\n      DEEPSONAR_WORKER_BOOTSTRAP_TOKEN: \${DEEPSONAR_WORKER_BOOTSTRAP_TOKEN}\n      DEEPSONAR_WORKER_ENDPOINT_HOSTS: ${workerProject}-opensandbox-1\n      DEEPSONAR_WORKER_SEED_LOCAL: "false"`), {mode:0o600});
    dc(root,['up','-d','--wait','--no-deps','scheduler']); await health(root,config.oldVersion);
    const scheduler = inspect(rootSchedulerId()), postgres = inspect(dc(root,['ps','-q','postgres']));
    const networks = Object.keys(scheduler.NetworkSettings.Networks).filter(name=>Object.hasOwn(postgres.NetworkSettings.Networks,name));
    assert.equal(networks.length,1,'root fixture must have one shared isolated PG network');
    const network = networks[0];
    const schedulerHost = scheduler.Name.replace(/^\//,'');
    let oldSources;
    if(config.oldWorkerSourceRevision !== undefined) {
      assert.match(config.oldWorkerSourceRevision,/^[a-f0-9]{40}$/);
      oldSources={script:execFileSync('git',['show',`${config.oldWorkerSourceRevision}:deploy/worker-register.mjs`],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',stdio:['ignore','pipe','pipe']}),contract:null};
    } else oldSources = JSON.parse(docker(['exec',scheduler.Id,'node','-e',"const fs=require('fs');console.log(JSON.stringify({script:fs.readFileSync('/app/deploy/worker-register.mjs','utf8'),contract:fs.existsSync('/app/deploy/worker-register-contract.mjs')?fs.readFileSync('/app/deploy/worker-register-contract.mjs','utf8'):null}))"]));
    assert.ok(oldSources.script);
    const inventory={nodes:[]};
    for (const kind of ['control','worker']) {
      const directory=join(ssh.directory,kind);await mkdir(directory,{mode:0o700});
      const project=kind==='control'?controlProject:workerProject;
      const services={};
      if(kind==='control') {
        for(const name of ['scheduler','web','image-admission']) {
          const original=inspect(dc(root,['ps','-q',name]));
          const environment={...envOf(original)};
          if(name==='web') environment.SCHEDULER_URL=`http://${controlProject}-scheduler-1:3100`;
          if(name==='scheduler') {environment.DEEPSONAR_WORKER_SEED_LOCAL='false';environment.DEEPSONAR_WORKER_BOOTSTRAP_TOKEN=bootstrap;environment.DEEPSONAR_WORKER_ENDPOINT_HOSTS=workerProject+'-opensandbox-1';}
          services[name]={image:config.versions[config.oldVersion][name],pull_policy:'never',environment:escapeEnvironment(environment),networks:['fixture'],...(name==='scheduler'?{volumes:['blobs:/app/data']}:{}),healthcheck:{test:['CMD','node','-e',name==='scheduler'?"fetch('http://127.0.0.1:3100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))":"process.exit(0)"],interval:'2s',timeout:'3s',retries:60}};
        }
      } else {
        await writeFile(join(directory,'worker-register.mjs'),oldSources.script,{mode:0o600});
        if(oldSources.contract)await writeFile(join(directory,'worker-register-contract.mjs'),oldSources.contract,{mode:0o600});
        services.opensandbox={image:NODE_IMAGE,pull_policy:'never',command:['node','-e',"require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({status:'ok'}))}).listen(8080,'0.0.0.0')"],networks:['fixture'],healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)})"],interval:'2s',timeout:'3s',retries:20}};
        services['worker-agent']={image:NODE_IMAGE,pull_policy:'never',restart:'unless-stopped',command:['node','/agent/worker-register.mjs'],networks:['fixture'],environment:escapeEnvironment({DEEPSONAR_VERSION:config.oldVersion,DEEPSONAR_CONTROL_PLANE:`http://${schedulerHost}:3100`,DEEPSONAR_WORKER_BOOTSTRAP_TOKEN:bootstrap,DEEPSONAR_WORKER_NODE_ID:workerId,DEEPSONAR_WORKER_ENDPOINT:endpoint,OPEN_SANDBOX_API_KEY:apiKey,DEEPSONAR_WORKER_HEARTBEAT_SEC:'5'}),volumes:['state:/var/lib/deepsonar-worker',{type:'bind',source:join(directory,'worker-register.mjs'),target:'/agent/worker-register.mjs',read_only:true},...(oldSources.contract?[{type:'bind',source:join(directory,'worker-register-contract.mjs'),target:'/agent/worker-register-contract.mjs',read_only:true}]:[])]};
      }
      await writeFile(join(directory,'compose.json'),JSON.stringify({services,networks:{fixture:{external:true,name:network}},volumes:kind==='control'?{blobs:{}}:{state:{}}}),{mode:0o600});
      const args=['compose','--project-directory',directory,'--project-name',project,'--file',join(directory,'compose.json')];projects.push(args);
      docker([...args,'up','-d','--wait','--wait-timeout','180']);
      inventory.nodes.push({id:kind==='control'?'control-replica':workerId,kind,ssh_host:ssh.sshHost,directory,project,compose_files:['compose.json']});
    }
    const inventoryPath=join(ssh.directory,'inventory.json');await writeFile(inventoryPath,JSON.stringify(inventory),{mode:0o600});
    const workerContainer=()=>docker([...projects[1],'ps','-q','worker-agent']);
    for(let attempt=0;attempt<40;attempt++) {
      try {oldNodeToken=docker(['exec',workerContainer(),'node','-e',"process.stdout.write(require('fs').readFileSync('/var/lib/deepsonar-worker/node.token','utf8').trim())"]);if(oldNodeToken)break;} catch {}
      await sleep(500);
    }
    assert.ok(oldNodeToken,'old worker must register and persist its real token');
    return {options:{nodes:inventoryPath,sshOptions:ssh.sshOptions},workerId,inventory,close,oldWorkerSource:{kind:config.oldWorkerSourceRevision?"git":"image",revision:config.oldWorkerSourceRevision??null,sha256:createHash("sha256").update(oldSources.script).digest("hex")},
      async assertPreparing(state) {
        const remoteScheduler=docker([...projects[0],'ps','-q','scheduler']);
        const response=JSON.parse(docker(['exec','-i',remoteScheduler,'node','--input-type=module','-e',command],JSON.stringify({url:'http://127.0.0.1:3100/health'})));
        assert.equal(response.status,200);assert.equal(response.data.ready,false);assert.equal(response.data.maintenance_ready,true);assert.equal(response.data.upgrade_generation,state.generation);
        return {remoteControlPreparing:true};
      },
      async assertActive(state,saved) {
        const remoteScheduler=docker([...projects[0],'ps','-q','scheduler']);
        const remoteHealth=JSON.parse(docker(['exec','-i',remoteScheduler,'node','--input-type=module','-e',command],JSON.stringify({url:'http://127.0.0.1:3100/health'})));
        assert.equal(remoteHealth.status,200);assert.equal(remoteHealth.data.ready,true);assert.equal(remoteHealth.data.version,config.newVersion);
        // Active health has no maintenance identity fields; verify them through the actual remote DB connection below.
        const schemaCode="const {sql}=await import('/app/apps/scheduler/dist/db.js');try{const [r]=await sql`SELECT (SELECT version FROM schema_meta WHERE id='global') AS version,generation,phase FROM platform_upgrade_state WHERE id='global'`;console.log(JSON.stringify(r));}finally{await sql.end({timeout:5})}";
        const remoteState=JSON.parse(docker(['exec',remoteScheduler,'node','--input-type=module','-e',schemaCode]));
        assert.equal(remoteState.version,config.newSchema);assert.equal(remoteState.generation,state.generation);assert.equal(remoteState.phase,'active');
        const rootId=rootSchedulerId();
        const claimCode="let raw='';for await(const b of process.stdin)raw+=b;const p=JSON.parse(raw);const r=await import('/app/apps/scheduler/dist/domains/worker-nodes/registry.js');const {sql}=await import('/app/apps/scheduler/dist/db.js');try{r.clearWorkerApiKeysForTests();r.rememberWorkerApiKey(p.id,p.key);const claim=await r.claimWorkerForDispatch();if(claim)await r.releaseSandboxLease(claim.reservationId);console.log(JSON.stringify({claimed:claim?.id??null}));}finally{await sql.end({timeout:5})}";
        const claim=()=>JSON.parse(docker(['exec','-i',rootId,'node','--input-type=module','-e',claimCode],JSON.stringify({id:workerId,key:apiKey})));
        assert.equal(claim().claimed,workerId,'admitted current generation must be dispatchable');
        docker(['stop',workerContainer()]);
        // Test the public identity spoof while the worker is still online, not after another request already fenced it.
        const spoof=JSON.parse(docker(['exec','-i',rootId,'node','--input-type=module','-e',command],JSON.stringify({url:'http://127.0.0.1:3100/workers/heartbeat',token:oldNodeToken,body:{node_id:workerId,protocol_version:1,platform_version:config.newVersion,deployment_generation:state.generation}})));
        assert.equal(spoof.data.status,'unavailable');assert.equal(claim().claimed,null);
        const response=JSON.parse(docker(['exec','-i',rootId,'node','--input-type=module','-e',command],JSON.stringify({url:'http://127.0.0.1:3100/workers/heartbeat',token:oldNodeToken,body:{node_id:workerId,protocol_version:1,platform_version:config.oldVersion,deployment_generation:''}})));
        assert.equal(response.status,200);assert.equal(response.data.status,'unavailable');assert.equal(claim().claimed,null,'old generation cannot claim work');
        return {remoteControlReady:true,workerAdmitted:true,oldGenerationFenced:true,publicGenerationSpoofFenced:true,network};
      },
    };
  } catch(error) {await close();throw error;}
}
