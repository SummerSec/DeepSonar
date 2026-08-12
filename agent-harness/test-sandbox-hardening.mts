// SEC-03 验证：AgentboxRunner provision 的容器必须带资源/权限硬限制
import { AgentboxRunner } from "../packages/runtime-sandbox/src/index.ts";
import { execFileSync } from "node:child_process";

const runner = new AgentboxRunner();
const handle = await runner.provision({
  jobId: "test-hardening-0001",
  attemptId: "attempt-hardening-0001",
  image: "alpine:latest",
  network: "none",
  limits: { cpu: 1.5, memoryMiB: 256, pidsLimit: 128, capDropAll: true, noNewPrivileges: true },
});
console.log("sandboxId:", handle.sandboxId);

const inspect = JSON.parse(execFileSync("docker", ["inspect", handle.sandboxId]).toString())[0];
const hc = inspect.HostConfig;
const checks = [
  ["NanoCpus", hc.NanoCpus === 1.5e9, hc.NanoCpus],
  ["Memory", hc.Memory === 256 * 1024 * 1024, hc.Memory],
  ["PidsLimit", hc.PidsLimit === 128, hc.PidsLimit],
  ["CapDrop ALL", JSON.stringify(hc.CapDrop) === '["ALL"]', JSON.stringify(hc.CapDrop)],
  ["no-new-privileges", (hc.SecurityOpt ?? []).includes("no-new-privileges:true"), JSON.stringify(hc.SecurityOpt)],
  ["NetworkMode none", hc.NetworkMode === "none", hc.NetworkMode],
];
let fail = 0;
for (const [name, ok, actual] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${actual}`);
  if (!ok) fail++;
}
console.log("isAlive:", await runner.isAlive(handle));
await runner.destroy(handle);
console.log("destroyed; isAlive after destroy:", await runner.isAlive(handle));
process.exit(fail ? 1 : 0);
