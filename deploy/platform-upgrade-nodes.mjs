import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

export function validateNodeInventory(inventory, registeredWorkerIds) {
  if (!inventory || Object.keys(inventory).some(key => key !== "nodes") || !Array.isArray(inventory.nodes)) throw new Error("explicit node inventory is required");
  const ids = new Set();
  const targets = new Set();
  const nodes = inventory.nodes.map(value => {
    if (!value || Object.keys(value).sort().join(",") !== "compose_files,directory,id,kind,project,ssh_host") throw new Error("invalid node inventory fields");
    const { id, kind, ssh_host, directory, project, compose_files } = value;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(id) || ids.has(id)) throw new Error("invalid or duplicate node id");
    if (!["worker", "control"].includes(kind)) throw new Error("invalid node kind");
    if (typeof ssh_host !== "string" || !/^(?:[a-z_][a-z0-9_-]{0,31}@)?[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(ssh_host)) throw new Error("invalid SSH host");
    if (typeof directory !== "string" || !/^\/[A-Za-z0-9._/-]+$/.test(directory) || directory.split("/").slice(1).some(part => !part || part === "." || part === "..")) throw new Error("invalid node directory");
    if (typeof project !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error("invalid compose project");
    if (!Array.isArray(compose_files) || !compose_files.length || new Set(compose_files).size !== compose_files.length || compose_files.some(file => typeof file !== "string" || !/^[A-Za-z0-9._/-]+$/.test(file) || file.split("/").some(part => !part || part === "." || part === ".."))) throw new Error("invalid compose files");
    const target = `${ssh_host}\n${directory}`;
    if (targets.has(target)) throw new Error("duplicate node deployment target");
    ids.add(id); targets.add(target);
    return { id, kind, ssh_host, directory, project, compose_files: [...compose_files] };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (registeredWorkerIds !== undefined) {
    if (!Array.isArray(registeredWorkerIds) || new Set(registeredWorkerIds).size !== registeredWorkerIds.length ||
      JSON.stringify([...registeredWorkerIds].sort()) !== JSON.stringify(nodes.filter(node => node.kind === "worker").map(node => node.id).sort())) throw new Error("worker inventory must match all registered remote worker IDs exactly");
  }
  return { nodes, bindingHash: createHash("sha256").update(JSON.stringify(nodes)).digest("hex") };
}

/** Self-contained actor shipped over stdin. Only Node stdlib and Docker Compose are required remotely. */
export async function remoteNodeAction(request, testDependencies = {}) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { execFile: exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(exec);
  const run = testDependencies.run ?? (async (args) => {
    try { return (await execute("docker", args, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })).stdout; }
    catch { throw new Error("managed node Docker operation failed; target remains fenced"); }
  });
  const { node, generation, action, inventoryBindingHash } = request;
  validateNodeInventory({ nodes: [node] });
  if (!/^[a-f0-9-]{36}$/.test(generation) || !/^[a-f0-9]{64}$/.test(inventoryBindingHash)) throw new Error("invalid upgrade generation or inventory binding");
  if (!["prepare", "inspect", "fence"].includes(action)) throw new Error("invalid managed node action");
  const sha = value => createHash("sha256").update(value).digest("hex");
  const binding = sha(JSON.stringify(node));
  const root = await fs.realpath(node.directory);
  if (root !== node.directory) throw new Error("node directory must be canonical and not a symlink");
  for (const file of node.compose_files) {
    if (await fs.realpath(path.join(root, file)) !== path.join(root, file)) throw new Error("compose file must not traverse symlinks");
  }
  const upgradeRoot = path.join(root, ".upgrade");
  await fs.mkdir(upgradeRoot, { recursive: true, mode: 0o700 });
  if (await fs.realpath(upgradeRoot) !== upgradeRoot) throw new Error("upgrade directory must not be a symlink");
  const directory = path.join(upgradeRoot, generation);
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  if (await fs.realpath(directory) !== directory) throw new Error("generation directory must not be a symlink");
  const metadataPath = path.join(directory, "node.json");
  const overlayPath = path.join(directory, "compose.json");
  const services = node.kind === "worker" ? ["worker-agent", "opensandbox"] : ["scheduler", "web", "image-admission"];
  const base = ["compose", "--project-directory", root, "--project-name", node.project,
    ...node.compose_files.flatMap(file => ["--file", path.join(root, file)])];
  const existing = JSON.parse(await run([...base, "config", "--format", "json"]));
  if (existing.name !== node.project || services.some(service => !existing.services?.[service])) throw new Error("inventory compose project/service mismatch");
  if (node.kind === "worker" && existing.services["worker-agent"].environment?.DEEPSONAR_WORKER_NODE_ID !== node.id) throw new Error("worker inventory ID must match the configured installation identity");
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw new Error("invalid managed node state"); }
  if (metadata) {
    const { request_hash, ...recorded } = metadata;
    if (sha(JSON.stringify(recorded)) !== request_hash) throw new Error("managed node state checksum mismatch");
  }
  if (metadata && (metadata.binding_hash !== binding || metadata.inventory_binding_hash !== inventoryBindingHash || metadata.generation !== generation)) throw new Error("managed node state binding mismatch");
  const compose = metadata ? [...base, "--file", overlayPath] : base;
  // Inspect only exact Compose-owned containers, never expand to an endpoint-derived target.
  async function containers(args) {
    const ids = (await run([...args, "ps", "--all", "--quiet", ...services])).trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return [];
    if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error("invalid compose container identity");
    const rows = JSON.parse(await run(["inspect", ...ids]));
    for (const row of rows) {
      const labels = row.Config?.Labels ?? {};
      if (labels["com.docker.compose.project"] !== node.project || labels["com.docker.compose.project.working_dir"] !== root || !services.includes(labels["com.docker.compose.service"])) throw new Error("container is outside the inventory project");
    }
    return rows;
  }
  await containers(compose);
  if (action === "fence") {
    await run([...compose, "stop", ...services]);
    return { node_id: node.id, kind: node.kind, generation, binding_hash: binding, inventory_binding_hash: inventoryBindingHash, stopped: true };
  }
  async function privateWrite(file, value) {
    const current = await fs.lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (current?.isSymbolicLink()) throw new Error("refusing managed file symlink");
    const temporary = `${file}.tmp-${randomUUID()}`;
    const handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(value); await handle.sync();
      await handle.close();
      await fs.rename(temporary, file);
      const parent = await fs.open(path.dirname(file), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }
  if (action === "prepare") {
    const { version } = request;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("invalid target release version");
    const environment = { DEEPSONAR_VERSION: version, [node.kind === "worker" ? "DEEPSONAR_DEPLOYMENT_GENERATION" : "DEEPSONAR_UPGRADE_GENERATION"]: generation };
    const overlay = { services: {} };
    const evidence = { node_id: node.id, kind: node.kind, generation, version, binding_hash: binding, inventory_binding_hash: inventoryBindingHash };
    if (node.kind === "worker") {
      if (typeof request.generationToken !== "string" || request.generationToken.length < 32 || request.generationToken.length > 512) throw new Error("worker generation enrollment token is required");
      for (const key of ["workerScript", "workerContract"]) if (typeof request[key] !== "string" || !request[key] || request[key].length > 1024 * 1024) throw new Error("trusted candidate worker scripts are required");
      environment.DEEPSONAR_WORKER_GENERATION_TOKEN = request.generationToken;
      evidence.script_sha256 = sha(request.workerScript);
      evidence.contract_sha256 = sha(request.workerContract);
      if (evidence.script_sha256 !== request.workerScriptSha256 || evidence.contract_sha256 !== request.workerContractSha256) throw new Error("candidate worker script content hash mismatch");
      evidence.token_sha256 = sha(request.generationToken);
      overlay.services["worker-agent"] = { environment, volumes: [
        { type: "bind", source: path.join(directory, "worker-register.mjs"), target: "/agent/worker-register.mjs", read_only: true },
        { type: "bind", source: path.join(directory, "worker-register-contract.mjs"), target: "/agent/worker-register-contract.mjs", read_only: true },
      ] };
    } else {
      let databaseUrl = request.databaseUrl;
      if (request.databaseIdentity !== undefined) {
        const identity = request.databaseIdentity;
        if (databaseUrl !== undefined || !identity || Object.keys(identity).sort().join(",") !== "database,password,role" ||
          !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(identity.role ?? "") || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(identity.database ?? "") ||
          typeof identity.password !== "string" || !identity.password || identity.password.length > 512 || identity.role !== request.runtimeRole) throw new Error("invalid candidate database identity");
        const original = existing.services.scheduler.environment?.DATABASE_URL;
        if (typeof original !== "string" || !/^postgres(?:ql)?:\/\//.test(original)) throw new Error("existing remote database endpoint is required");
        const target = new URL(original.replaceAll("$$", "$"));
        target.username = identity.role;
        target.password = identity.password;
        target.pathname = `/${identity.database}`;
        databaseUrl = target.href;
      }
      if (typeof databaseUrl !== "string" || !/^postgres(?:ql)?:\/\/[^\s]+$/.test(databaseUrl) || databaseUrl.length > 4096) throw new Error("candidate database URL is required");
      if (!/^[a-zA-Z0-9_-]{1,63}$/.test(request.runtimeRole ?? "")) throw new Error("candidate runtime database role is required");
      environment.DATABASE_URL = databaseUrl;
      environment.DEEPSONAR_RUNTIME_ROLE = request.runtimeRole;
      evidence.database_sha256 = sha(databaseUrl);
      evidence.runtime_role = request.runtimeRole;
      evidence.images = {};
      for (const service of services) {
        const ref = request.images?.[service];
        if (typeof ref !== "string" || !new RegExp(`^[a-z0-9.-]+/[a-z0-9._/-]+/deepsonar-${service}@sha256:[a-f0-9]{64}$`).test(ref)) throw new Error("candidate platform digest references are required");
        evidence.images[service] = ref;
        overlay.services[service] = { image: ref, environment };
      }
    }
    const requestHash = sha(JSON.stringify(evidence));
    if (metadata && metadata.request_hash !== requestHash) throw new Error("generation already bound to a different candidate");
    await run([...compose, "stop", ...services]);
    // Compose performs interpolation even in JSON. Escape every dollar so credentials stay literal.
    for (const service of Object.values(overlay.services)) service.environment = Object.fromEntries(Object.entries(service.environment).map(([key, value]) => [key, value.replaceAll("$", () => "$$")]));
    if (node.kind === "worker") {
      await privateWrite(path.join(directory, "worker-register.mjs"), request.workerScript);
      await privateWrite(path.join(directory, "worker-register-contract.mjs"), request.workerContract);
    }
    await privateWrite(overlayPath, JSON.stringify(overlay));
    metadata = { ...evidence, request_hash: requestHash };
    await privateWrite(metadataPath, JSON.stringify(metadata));
    const target = [...base, "--file", overlayPath];
    await run([...target, "config", "--quiet"]);
    // Worker-agent may restart while preparing; opensandbox health and inspected byte/env identity establish readiness.
    await run([...target, "up", "--detach", "--wait", "--force-recreate", "--no-deps", ...services]);
  }
  if (!metadata) throw new Error("node has no prepared generation");
  const rows = await containers([...base, "--file", overlayPath]);
  if (rows.length !== services.length || new Set(rows.map(row => row.Config.Labels["com.docker.compose.service"])).size !== services.length) throw new Error("prepared generation is missing a service container");
  for (const row of rows) {
    const service = row.Config.Labels["com.docker.compose.service"];
    if (!row.State?.Running && !(node.kind === "worker" && service === "worker-agent" && row.State?.Restarting)) throw new Error("prepared service is not running");
    if (node.kind === "worker" && service === "opensandbox") continue;
    const env = Object.fromEntries((row.Config.Env ?? []).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
    if (env.DEEPSONAR_VERSION !== metadata.version || env[node.kind === "worker" ? "DEEPSONAR_DEPLOYMENT_GENERATION" : "DEEPSONAR_UPGRADE_GENERATION"] !== generation) throw new Error("running service version or generation mismatch");
    if (node.kind === "worker") {
      if (sha(env.DEEPSONAR_WORKER_GENERATION_TOKEN ?? "") !== metadata.token_sha256) throw new Error("worker enrollment token hash mismatch");
      for (const [filename, expected] of [["worker-register.mjs", metadata.script_sha256], ["worker-register-contract.mjs", metadata.contract_sha256]]) {
        const source = path.join(directory, filename);
        if (!row.Mounts?.some(mount => mount.Type === "bind" && mount.Source === source && mount.Destination === `/agent/${filename}` && mount.RW === false) || sha(await fs.readFile(source)) !== expected) throw new Error("running worker script bytes or readonly mount mismatch");
      }
    } else if (row.Config.Image !== metadata.images[service] || sha(env.DATABASE_URL ?? "") !== metadata.database_sha256 || env.DEEPSONAR_RUNTIME_ROLE !== metadata.runtime_role) throw new Error("running control service candidate identity mismatch");
  }
  const evidence = Object.fromEntries(["node_id", "kind", "generation", "version", "binding_hash", "inventory_binding_hash", "script_sha256", "contract_sha256", "token_sha256", "database_sha256", "runtime_role", "images"].filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]]));
  evidence.services = services;
  if (node.kind === "control") {
    const scheduler = rows.find(row => row.Config.Labels["com.docker.compose.service"] === "scheduler");
    const health = JSON.parse(await run(["exec", scheduler.Id, "node", "-e", "fetch('http://127.0.0.1:'+(process.env.SCHEDULER_PORT||'3100')+'/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"]));
    evidence.health = Object.fromEntries(["version", "schema_version", "deployment_generation", "generation", "runtime_role", "maintenance", "maintenance_ready", "upgrade_phase", "upgrade_generation", "upgrade_runtime_role", "upgrade_target_version", "phase", "ready"].filter(key => Object.hasOwn(health, key)).map(key => [key, health[key]]));
  }
  return evidence;
}

// Neither credentials nor executable module text appear in SSH argv.
export const NODE_ACTOR_BOOTSTRAP = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{try{const p=JSON.parse(s);const c=await import('node:crypto');if(c.createHash('sha256').update(p.module).digest('hex')!==p.module_sha256)throw Error();const m=await import('data:text/javascript;base64,'+Buffer.from(p.module).toString('base64'));console.log(JSON.stringify(await m.execute(p.request)))}catch{console.error('managed node action failed');process.exit(1)}})";

export function createManagedNodeRunner({ inventory, registeredWorkerIds, transport }) {
  if (!Array.isArray(registeredWorkerIds)) throw new Error("registered remote worker IDs are required to bind the inventory");
  const { nodes, bindingHash } = validateNodeInventory(inventory, registeredWorkerIds);
  const module = `import {createHash} from 'node:crypto';\nconst validateNodeInventory = ${validateNodeInventory.toString()};\nexport const execute = ${remoteNodeAction.toString()};`;
  const module_sha256 = createHash("sha256").update(module).digest("hex");
  const send = transport ?? (async ({ node, envelope }) => new Promise((resolve, reject) => {
    const child = execFile("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "--", node.ssh_host,
      `node -e '${NODE_ACTOR_BOOTSTRAP.replaceAll("'", "'\\''")}'`], { timeout: 240_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error(`managed node ${node.id} SSH action failed; no target expansion attempted`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`managed node ${node.id} returned invalid evidence`)); }
    });
    child.stdin.end(JSON.stringify(envelope));
  }));
  async function invoke(action, input, expectedKind) {
    const node = nodes.find(node => node.id === input.id);
    if (!node || (expectedKind && node.kind !== expectedKind)) throw new Error("node is absent from the bound inventory or has the wrong kind");
    const result = await send({ node, envelope: { module, module_sha256, request: { ...input, node, inventoryBindingHash: bindingHash, action } } });
    if (!result || result.node_id !== node.id || result.kind !== node.kind || result.generation !== input.generation ||
      result.inventory_binding_hash !== bindingHash || result.binding_hash !== createHash("sha256").update(JSON.stringify(node)).digest("hex") ||
      (action === "prepare" && result.version !== input.version) || (action === "fence" && result.stopped !== true)) throw new Error("managed node returned evidence for another target or generation");
    return result;
  }
  return { bindingHash, nodes,
    prepareWorker: input => invoke("prepare", input, "worker"),
    prepareControl: input => invoke("prepare", input, "control"),
    inspect: input => invoke("inspect", input),
    fence: input => invoke("fence", input),
  };
}
