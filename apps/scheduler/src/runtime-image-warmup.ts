import { config } from "./config.js";
import { prepareRuntimeImage, resolveStartupRuntimeImages, sanitizeRuntimeImageError, withSharedAssetsHelperRef } from "./runtime-images.js";

export interface RuntimeImageWarmupStatus {
  status: "idle" | "preparing" | "ready" | "failed";
  ready: boolean;
  attempt: number;
  required: number;
  error: string | null;
  retry_at: string | null;
  official_trust_warnings?: string[];
}

export const DISPATCHER_DISABLED_LOG_AFTER = 3;

interface WarmupDependencies {
  resolveRefs: () => Promise<Array<{ image_ref: string; image_key?: string }>>;
  prepare: (imageRef: string) => Promise<void>;
  afterPrepare?: (refs: Array<{ image_ref: string; image_key?: string }>) => Promise<void>;
  onReady: () => void;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  sanitize?: (error: unknown) => string;
  log?: (level: "warn" | "error", message: string) => void;
}

export function createRuntimeImageWarmupCoordinator(deps: WarmupDependencies) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  }));
  const delays = deps.retryDelaysMs ?? [1_000, 5_000, 15_000, 30_000];
  let stopped = false;
  let started = false;
  let state: RuntimeImageWarmupStatus = {
    status: "idle", ready: false, attempt: 0, required: 0, error: null, retry_at: null,
  };

  const run = async () => {
    while (!stopped) {
      const attempt = state.attempt + 1;
      state = { ...state, status: "preparing", attempt, error: null, retry_at: null };
      try {
        const refs = await deps.resolveRefs();
        state = { ...state, required: new Set(refs.map((item) => item.image_ref)).size };
        for (const ref of new Set(refs.map((item) => item.image_ref))) await deps.prepare(ref);
        if (deps.afterPrepare) await deps.afterPrepare(refs);
        if (stopped) return;
        state = { ...state, status: "ready", ready: true, error: null, retry_at: null };
        deps.onReady();
        return;
      } catch (error) {
        const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 30_000;
        const safeError = (deps.sanitize ?? sanitizeRuntimeImageError)(error) || "runtime image warmup failed";
        state = {
          ...state,
          status: "failed",
          ready: false,
          error: safeError,
          retry_at: new Date(Date.now() + delay).toISOString(),
        };
        const log = deps.log ?? ((level, message) => (level === "error" ? console.error(message) : console.warn(message)));
        log("warn", `[runtime-images] startup warmup failed (attempt ${attempt}); retrying in ${delay}ms: ${safeError}`);
        if (attempt >= DISPATCHER_DISABLED_LOG_AFTER) {
          log(
            "error",
            `[runtime-images] dispatcher disabled because startup warmup is not ready (attempt ${attempt}): ${safeError}`,
          );
        }
        await sleep(delay);
      }
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      state = { ...state, status: "preparing" };
      void run();
    },
    stop() { stopped = true; },
    status: () => ({ ...state }),
  };
}

let startupCoordinator: ReturnType<typeof createRuntimeImageWarmupCoordinator> | null = null;

export function runtimeImageWarmupStatus(): RuntimeImageWarmupStatus {
  return startupCoordinator?.status() ?? {
    status: "idle", ready: false, attempt: 0, required: 0, error: null, retry_at: null,
  };
}

export function startRuntimeImageWarmupOnBoot(
  onReady: () => void,
  extras: { afterPrepare?: (refs: Array<{ image_ref: string; image_key?: string }>) => Promise<void> } = {},
): () => void {
  startupCoordinator = createRuntimeImageWarmupCoordinator({
    resolveRefs: async () => withSharedAssetsHelperRef(await resolveStartupRuntimeImages()),
    prepare: prepareRuntimeImage,
    afterPrepare: extras.afterPrepare,
    onReady,
  });
  if (config.runtime.agentMode === "fake" || config.runtime.provider !== "local-docker") {
    startupCoordinator = createRuntimeImageWarmupCoordinator({
      resolveRefs: async () => [],
      prepare: async () => {},
      onReady,
    });
  }
  startupCoordinator.start();
  return () => startupCoordinator?.stop();
}
