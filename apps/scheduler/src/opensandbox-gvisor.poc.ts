/**
 * Live gVisor + egress sidecar incompatibility proof (#162 Phase 3).
 * Downloads a pinned runsc only when OPEN_SANDBOX_POC_GVISOR=1.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { OPENSANDBOX_GVISOR_RUNSC_URL, runOpenSandboxGvisorPoc, shouldRunOpenSandboxGvisorPoc } from "@deepsonar/runtime-sandbox";

if (!shouldRunOpenSandboxGvisorPoc()) {
  console.log("skip: OpenSandbox gVisor PoC (set OPEN_SANDBOX_POC=1 OPEN_SANDBOX_POC_GVISOR=1)");
  process.exit(0);
}

const runscPath = process.env.OPEN_SANDBOX_POC_RUNSC?.trim() || "/tmp/runsc";
if (!existsSync(runscPath)) {
  const downloaded = spawnSync("curl", ["-fsSL", "-o", runscPath, OPENSANDBOX_GVISOR_RUNSC_URL], { encoding: "utf8" });
  if (downloaded.status !== 0) {
    throw new Error(`OPENSANDBOX_POC_GVISOR_DOWNLOAD: ${downloaded.stderr || downloaded.stdout}`);
  }
  chmodSync(runscPath, 0o755);
}

const result = await runOpenSandboxGvisorPoc(async (args) => {
  const rendered = spawnSync("sudo", ["-n", runscPath, ...args], { encoding: "utf8" });
  return {
    exitCode: rendered.status ?? 1,
    stdout: rendered.stdout,
    stderr: rendered.stderr,
  };
});
if (result.compatible || !result.natUnsupported || result.leftovers !== 0) {
  throw new Error(`OpenSandbox gVisor PoC unexpected result: ${JSON.stringify(result)}`);
}
console.log(`OK: OpenSandbox gVisor+egress compatible=false natUnsupported=true leftovers=0 runsc=${result.runscVersion.split("\n")[0]}`);
