import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagedNodeRunner, validateNodeInventory, NODE_ACTOR_BOOTSTRAP } from "./platform-upgrade-nodes.mjs";

const generation = "12345678-1234-1234-1234-123456789abc";
const digest = `sha256:${"a".repeat(64)}`;
const token = "fixture-generation-token-not-production";
const images = Object.fromEntries(["scheduler", "web", "image-admission"].map(key => [key, `ghcr.io/summersec/deepsonar-${key}@${digest}`]));
async function fixture(kind = "worker") {
  const directory = await mkdtemp(join(tmpdir(), "managed-node-"));
  await writeFile(join(directory, "compose.yml"), "services: {}\n");
  const node = { id: "fixture", kind, ssh_host: "fixture@managed.example", directory, project: `managed-fixture-${directory.split("/").at(-1).toLowerCase()}`, compose_files: ["compose.yml"] };
  const services = kind === "worker" ? ["worker-agent", "opensandbox"] : ["scheduler", "web", "image-admission"];
  const calls = [];
  let rows = [];
  let failUp = false;
  let lastEnvelope;
  const run = async args => {
    calls.push(args);
    if (args[0] === "inspect") return JSON.stringify(rows);
    if (args[0] === "exec") return JSON.stringify({ version: "0.5.7", schema_version: 60, generation, runtime_role: "candidate_role", phase: "preparing", unrelated: "must-not-leak" });
    assert.equal(args[0], "compose");
    assert.ok(args.includes(node.project));
    assert.ok(args.includes(directory));
    if (args.includes("config") && args.includes("--format")) return JSON.stringify({ name: node.project,
      services: Object.fromEntries(services.map(service => [service, { environment: service === "worker-agent" ? { DEEPSONAR_WORKER_NODE_ID: node.id } : service === "scheduler" ? { DATABASE_URL: "postgres://old:old@remote-db:5432/original?sslmode=require" } : {} }])) });
    if (args.includes("ps")) return rows.map(row => row.Id).join("\n");
    if (args.includes("stop")) { for (const row of rows) row.State.Running = false; return ""; }
    if (args.includes("up")) {
      if (failUp) throw new Error("fixture interrupted up");
      const overlay = JSON.parse(await readFile(join(directory, ".upgrade", generation, "compose.json"), "utf8"));
      rows = services.map((service, i) => {
        const entry = overlay.services[service] ?? {};
        return { Id: String(i + 1).repeat(64), Config: {
          Labels: { "com.docker.compose.project": node.project, "com.docker.compose.project.working_dir": directory, "com.docker.compose.service": service },
          Env: Object.entries(entry.environment ?? {}).map(([key, value]) => `${key}=${value.replaceAll("$$", "$")}`), Image: entry.image,
        }, State: { Running: true }, Mounts: (entry.volumes ?? []).map(volume => ({ Type: "bind", Source: volume.source, Destination: volume.target, RW: !volume.read_only })) };
      });
      return "";
    }
    if (args.includes("config")) return "";
    throw new Error(`unexpected fixture command ${args.join(" ")}`);
  };
  const inventory = { nodes: [node] };
  const runner = createManagedNodeRunner({ inventory, registeredWorkerIds: kind === "worker" ? [node.id] : [], transport: async ({ envelope }) => {
    lastEnvelope = envelope;
    assert.equal(createHash("sha256").update(envelope.module).digest("hex"), envelope.module_sha256);
    // Execute the actual transmitted module, with Docker replaced by an isolated fixture.
    const module = await import(`data:text/javascript;base64,${Buffer.from(envelope.module).toString("base64")}`);
    return module.execute(envelope.request, { run });
  } });
  return { directory, node, inventory, runner, calls, rows: () => rows, envelope: () => lastEnvelope,
    failUp: value => { failUp = value; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const workerRequest = { id: "fixture", generation, version: "0.5.7", generationToken: token, workerScript: "// trusted worker candidate\n", workerContract: "// trusted worker contract\n" };
workerRequest.workerScriptSha256 = createHash("sha256").update(workerRequest.workerScript).digest("hex");
workerRequest.workerContractSha256 = createHash("sha256").update(workerRequest.workerContract).digest("hex");

test("inventory is explicit, binds every remote worker and rejects target expansion", () => {
  const node = { id: "w", kind: "worker", ssh_host: "ops@worker.example", directory: "/srv/deepsonar", project: "worker", compose_files: ["deploy/compose.yml"] };
  assert.equal(validateNodeInventory({ nodes: [node] }, ["w"]).nodes.length, 1);
  assert.throws(() => createManagedNodeRunner({ inventory: { nodes: [node] } }), /IDs are required/);
  for (const patch of [{ ssh_host: "-oProxyCommand=evil" }, { ssh_host: "worker;evil" }, { directory: "/srv/../other" }, { project: "--all" }, { compose_files: ["../other.yml"] }, { extra: true }]) {
    assert.throws(() => validateNodeInventory({ nodes: [{ ...node, ...patch }] }, ["w"]));
  }
  assert.throws(() => validateNodeInventory({ nodes: [] }, ["w"]), /match all/);
  assert.throws(() => validateNodeInventory({ nodes: [node, node] }), /duplicate/);
  assert.equal(NODE_ACTOR_BOOTSTRAP.includes(token), false);
});

test("worker preparation is private, target-bound, repeatable and verifies installed bytes and token hash", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.runner.prepareWorker({ ...workerRequest, workerScriptSha256: "0".repeat(64) }), /content hash mismatch/);
    assert.equal(f.calls.some(args => args.includes("stop")), false);
    const result = await f.runner.prepareWorker(workerRequest);
    assert.equal(result.generation, generation);
    assert.equal(result.token_sha256, createHash("sha256").update(token).digest("hex"));
    assert.equal(JSON.stringify(result).includes(token), false);
    for (const name of ["compose.json", "node.json", "worker-register.mjs", "worker-register-contract.mjs"]) {
      assert.equal((await stat(join(f.directory, ".upgrade", generation, name))).mode & 0o777, 0o600);
    }
    assert.equal(f.calls.flat().some(arg => arg.includes(token)), false);
    assert.ok(f.calls.findIndex(args => args.includes("stop")) < f.calls.findIndex(args => args.includes("up")));
    assert.deepEqual(await f.runner.inspect({ id: "fixture", generation }), result);
    assert.deepEqual(await f.runner.prepareWorker(workerRequest), result);
    const stops = f.calls.filter(args => args.includes("stop")).length;
    await assert.rejects(() => f.runner.prepareWorker({ ...workerRequest, generationToken: "different-token-with-sufficient-entropy" }), /different candidate/);
    assert.equal(f.calls.filter(args => args.includes("stop")).length, stops);
    await assert.rejects(() => f.runner.prepareWorker({ ...workerRequest, id: "not-listed" }), /absent/);
    await writeFile(join(f.directory, ".upgrade", generation, "worker-register.mjs"), "tampered");
    await assert.rejects(() => f.runner.inspect({ id: "fixture", generation }), /script bytes/);
    const fenced = await f.runner.fence({ id: "fixture", generation });
    assert.equal(fenced.stopped, true);
    assert.ok(f.rows().every(row => !row.State.Running));
  } finally { await f.cleanup(); }
});

test("interrupted candidate start can resume only the identical generation payload", async () => {
  const f = await fixture();
  try {
    f.failUp(true);
    await assert.rejects(() => f.runner.prepareWorker(workerRequest), /interrupted up/);
    f.failUp(false);
    assert.equal((await f.runner.prepareWorker(workerRequest)).version, "0.5.7");
    f.rows()[0].Config.Labels["com.docker.compose.project"] = "another-project";
    const stops = f.calls.filter(args => args.includes("stop")).length;
    await assert.rejects(() => f.runner.fence({ id: "fixture", generation }), /outside the inventory/);
    assert.equal(f.calls.filter(args => args.includes("stop")).length, stops);
  } finally { await f.cleanup(); }
});

test("control preparation pins all three images and candidate DB, reports only sanitized maintenance health", async () => {
  const f = await fixture("control");
  try {
    const databaseUrl = "postgres://candidate:p$a$$word@db:5432/candidate";
    const result = await f.runner.prepareControl({ id: "fixture", generation, version: "0.5.7", runtimeRole: "candidate_role", databaseUrl, images });
    assert.equal(result.health.phase, "preparing");
    assert.equal(result.health.unrelated, undefined);
    assert.equal(JSON.stringify(result).includes(databaseUrl), false);
    assert.equal(f.calls.flat().some(arg => arg.includes(databaseUrl)), false);
    assert.deepEqual(result.images, images);
    f.rows()[0].Config.Env = f.rows()[0].Config.Env.map(value => value.startsWith("DATABASE_URL=") ? "DATABASE_URL=postgres://wrong" : value);
    await assert.rejects(() => f.runner.inspect({ id: "fixture", generation }), /candidate identity/);
  } finally { await f.cleanup(); }
});

test("real Compose merge preserves the worker state volume and literal credentials while replacing script binds", { skip: process.env.DEEPSONAR_TEST_MANAGED_NODE_CONTAINERS !== "1" ? "set DEEPSONAR_TEST_MANAGED_NODE_CONTAINERS=1 with the pinned Node image cached" : false }, async () => {
  const { execFileSync } = await import("node:child_process");
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "compose.yml"), JSON.stringify({ services: {
      "worker-agent": { image: "node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46", command: ["node", "-e", "setInterval(()=>{},1000)"], environment: { DEEPSONAR_WORKER_NODE_ID: "fixture" }, volumes: [
        { type: "volume", source: "worker-state", target: "/var/lib/deepsonar-worker" },
        { type: "bind", source: join(f.directory, "old-worker.mjs"), target: "/agent/worker-register.mjs", read_only: true },
      ] }, opensandbox: { image: "node:22" },
    }, volumes: { "worker-state": {} } }));
    const generationToken = "fixture-$literal-$$-token-long-enough";
    await f.runner.prepareWorker({ ...workerRequest, generationToken });
    const config = JSON.parse(execFileSync("docker", ["compose", "--project-directory", f.directory, "--project-name", f.node.project,
      "--file", join(f.directory, "compose.yml"), "--file", join(f.directory, ".upgrade", generation, "compose.json"), "config", "--format", "json"], { encoding: "utf8" }));
    const worker = config.services["worker-agent"];
    assert.equal(worker.environment.DEEPSONAR_WORKER_GENERATION_TOKEN, generationToken.replaceAll("$", () => "$$"));
    assert.ok(worker.volumes.some(volume => volume.type === "volume" && volume.target === "/var/lib/deepsonar-worker"));
    assert.equal(worker.volumes.filter(volume => volume.target === "/agent/worker-register.mjs").length, 1);
    assert.equal(worker.volumes.find(volume => volume.target === "/agent/worker-register.mjs").source, join(f.directory, ".upgrade", generation, "worker-register.mjs"));
    const args = ["compose", "--project-directory", f.directory, "--project-name", f.node.project,
      "--file", join(f.directory, "compose.yml"), "--file", join(f.directory, ".upgrade", generation, "compose.json")];
    try {
      execFileSync("docker", [...args, "up", "--detach", "--no-deps", "--pull", "never", "worker-agent"], { stdio: "pipe" });
      const id = execFileSync("docker", [...args, "ps", "--quiet", "worker-agent"], { encoding: "utf8" }).trim();
      const actual = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8" }))[0];
      assert.ok(actual.Config.Env.includes(`DEEPSONAR_WORKER_GENERATION_TOKEN=${generationToken}`));
    } finally {
      execFileSync("docker", [...args, "down", "--volumes", "--remove-orphans"], { stdio: "pipe" });
    }

  } finally { await f.cleanup(); }
});


test("remote control database identity preserves its configured endpoint and query", async () => {
  const f = await fixture("control");
  try {
    const result = await f.runner.prepareControl({ id: "fixture", generation, version: "0.5.7", runtimeRole: "candidate_role", images,
      databaseIdentity: { role: "candidate_role", password: "p@ss$literal", database: "candidate_db" } });
    const value = f.rows()[0].Config.Env.find(value => value.startsWith("DATABASE_URL=")).slice("DATABASE_URL=".length);
    const parsed = new URL(value);
    assert.equal(parsed.hostname, "remote-db");
    assert.equal(parsed.port, "5432");
    assert.equal(parsed.search, "?sslmode=require");
    assert.equal(parsed.pathname, "/candidate_db");
    assert.equal(decodeURIComponent(parsed.password), "p@ss$literal");
    assert.equal(result.database_sha256, createHash("sha256").update(value).digest("hex"));
  } finally { await f.cleanup(); }
});
