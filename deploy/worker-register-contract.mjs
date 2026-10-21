/** This is the registration agent protocol, not the OpenSandbox server version. */
export const WORKER_PROTOCOL_VERSION = 1;
export function workerReleaseIdentity(env) {
  const platformVersion = env.DEEPSONAR_VERSION?.trim();
  if (!platformVersion || platformVersion.length > 128) throw new Error("worker agent requires DEEPSONAR_VERSION from its release");
  const generation = env.DEEPSONAR_DEPLOYMENT_GENERATION?.trim() ?? "";
  if (generation.length > 128) throw new Error("invalid deployment generation");
  const generationToken = env.DEEPSONAR_WORKER_GENERATION_TOKEN?.trim();
  if (generation && (!generationToken || generationToken.length > 512)) throw new Error("managed worker requires its generation enrollment token");
  return {
    body: { protocol_version: WORKER_PROTOCOL_VERSION, platform_version: platformVersion, deployment_generation: generation },
    headers: generationToken ? { "x-deepsonar-worker-generation-token": generationToken } : {},
  };
}
