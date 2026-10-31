import type { RuntimeImageReadiness } from "./runtime-image-readiness.js";

export class RuntimeImageNotReadyError extends Error {
  readonly code = "runtime_image_not_ready" as const;
  readonly imageKey: string | null;
  readonly readiness: RuntimeImageReadiness;
  readonly preparing: boolean;
  readonly taskId: string | null;
  readonly checkedAt: string;

  constructor(readonly imageRef: string, extras?: {
    imageKey?: string | null;
    readiness?: RuntimeImageReadiness;
    preparing?: boolean;
    taskId?: string | null;
    checkedAt?: string;
    message?: string;
  }) {
    super(extras?.message ?? `runtime_image_not_ready: runtime image is not prepared locally: ${imageRef}`);
    this.name = "RuntimeImageNotReadyError";
    this.imageKey = extras?.imageKey ?? null;
    this.readiness = extras?.readiness ?? "unavailable";
    this.preparing = extras?.preparing ?? false;
    this.taskId = extras?.taskId ?? null;
    this.checkedAt = extras?.checkedAt ?? new Date().toISOString();
  }
}
