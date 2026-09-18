/**
 * Pre-dispatch OpenSandbox upload-channel probe (#605).
 *
 * Creates a short-lived sandbox, writes a 1KB payload through writeFilesWithRetry,
 * then destroys the sandbox. Soft-skips when DEEPSONAR_OPENSANDBOX_UPLOAD_PROBE_IMAGE
 * is unset so local/unit environments are not fail-closed on missing images.
 */
import {
  OPENSANDBOX_ATTEMPT_META,
  OPENSANDBOX_JOB_META,
  createSdkOpenSandboxClient,
  readOpenSandboxPin,
} from "@deepsonar/runtime-sandbox";
import { config } from "./config.js";

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_PAYLOAD = Buffer.alloc(1024, 0x61); // 1KB of 'a'

export async function defaultOpenSandboxUploadProbe(): Promise<void | { skipped: true }> {
  const image = config.runtime.openSandbox.uploadProbeImage?.trim() ?? "";
  if (!image) {
    return { skipped: true };
  }
  if (config.runtime.agentMode !== "real" || config.runtime.provider !== "opensandbox") {
    return { skipped: true };
  }
  if (!config.runtime.openSandbox.apiKey.trim()) {
    throw new Error("OPEN_SANDBOX_API_KEY missing for upload probe");
  }

  const pin = readOpenSandboxPin({
    sdk: config.runtime.openSandbox.sdkVersion || undefined,
    serverImage: config.runtime.openSandbox.serverImage || undefined,
    execdImage: config.runtime.openSandbox.execdImage || undefined,
    egressImage: config.runtime.openSandbox.egressImage || undefined,
  });
  const client = createSdkOpenSandboxClient({
    domain: config.runtime.openSandbox.domain,
    apiKey: config.runtime.openSandbox.apiKey,
    protocol: config.runtime.openSandbox.protocol,
    useServerProxy: config.runtime.openSandbox.useServerProxy,
    pin,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: Awaited<ReturnType<typeof client.create>> | undefined;
  try {
    const work = (async () => {
      session = await client.create({
        image,
        env: {},
        metadata: {
          "deepsonar.probe": "upload-circuit",
          [OPENSANDBOX_JOB_META]: "upload-probe",
          [OPENSANDBOX_ATTEMPT_META]: "upload-probe",
        },
        resource: { cpu: "500m", memory: "256Mi" },
        timeoutSeconds: null,
        networkPolicy: { defaultAction: "deny", egress: [] },
        volumes: [],
      });
      await session.writeFile("/tmp/deepsonar-upload-probe.bin", PROBE_PAYLOAD);
    })();
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("opensandbox upload probe timed out")), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (session) {
      await session.kill().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }
}
