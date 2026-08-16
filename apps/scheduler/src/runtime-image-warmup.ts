import { config } from "./config.js";
import { prepareRuntimeImage, resolveStartupRuntimeImages, sanitizeRuntimeImageError } from "./runtime-images.js";

export interface RuntimeImageWarmupStatus {
  status: "idle" | "preparing" | "ready" | "failed";
  ready: boolean;
  attempt: number;
  required: number;
  error: string | null;
  retry_at: string | null;
}

interface WarmupDependencies {
  resolveRefs: () => Promise<Array<{ image_ref: string }>>;
  prepare: (imageRef: string) => Promise<void>;
  onReady: () => void;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  sanitize?: (error: unknown) => string;
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
        console.warn(`[runtime-images] startup warmup failed (attempt ${attempt}); retrying in ${delay}ms: ${safeError}`);
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

export function startRuntimeImageWarmupOnBoot(onReady: () => void): () => void {
  startupCoordinator = createRuntimeImageWarmupCoordinator({
    resolveRefs: () => resolveStartupRuntimeImages(),
    prepare: prepareRuntimeImage,
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
