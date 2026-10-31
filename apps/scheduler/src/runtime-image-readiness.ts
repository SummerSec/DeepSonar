import { managesHostDockerRuntime } from "./config.js";
import { runtimeImageNotReady } from "./control-input.js";
import {
  redactRuntimeImageReadinessError,
  type RuntimeImagePullItem,
  type RuntimeImagePullTask,
} from "./runtime-image-pull-status.js";

export type RuntimeImageReadiness = "ready" | "preparing" | "unavailable" | "error";

export interface RuntimeImageReadinessView {
  readiness: RuntimeImageReadiness;
  preparing: boolean;
  error_code: string | null;
  error: string | null;
  checked_at: string;
  task_id: string | null;
}

export interface HubRuntimeImageReadinessEntry extends RuntimeImageReadinessView {
  image_key: string;
}

export interface RuntimeImageStatusEntry extends RuntimeImageReadinessView {
  image_key: string;
  immutable_ref: string | null;
  phase: string;
}

function matchingPullItems(
  pull: RuntimeImagePullTask | null,
  imageKey: string,
  imageRef: string | null,
): RuntimeImagePullItem[] {
  if (!pull) return [];
  return pull.items.filter((item) => (
    item.image_key === imageKey || (imageRef !== null && item.image_ref === imageRef)
  ));
}

function failedItemError(item: RuntimeImagePullItem): { error_code: string; error: string } {
  if (item.error_code) {
    return {
      error_code: item.error_code,
      error: redactRuntimeImageReadinessError(item.error || "镜像准备失败。"),
    };
  }
  return {
    error_code: "pull_failed",
    error: redactRuntimeImageReadinessError(item.error || "镜像准备失败。"),
  };
}

export function classifyRuntimeImageReadinessFromState(input: {
  imageKey: string;
  imageRef: string | null;
  pull: RuntimeImagePullTask | null;
  localAvailable: boolean | null;
  hostManaged: boolean;
  checkedAt?: string;
}): RuntimeImageReadinessView {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const items = matchingPullItems(input.pull, input.imageKey, input.imageRef);
  const active = items.find((item) => item.status === "queued" || item.status === "running");
  if (active) {
    return {
      readiness: "preparing",
      preparing: true,
      error_code: null,
      error: null,
      checked_at: checkedAt,
      task_id: input.pull?.task_id ?? null,
    };
  }
  const failed = [...items].reverse().find((item) => item.status === "failed");
  if (input.hostManaged) {
    if (input.localAvailable === true) {
      return {
        readiness: "ready",
        preparing: false,
        error_code: null,
        error: null,
        checked_at: checkedAt,
        task_id: null,
      };
    }
    if (failed) {
      const detail = failedItemError(failed);
      return {
        readiness: "error",
        preparing: false,
        error_code: detail.error_code,
        error: detail.error,
        checked_at: checkedAt,
        task_id: input.pull?.task_id ?? null,
      };
    }
    return {
      readiness: "unavailable",
      preparing: false,
      error_code: "not_pulled",
      error: "镜像尚未在本机准备完成。",
      checked_at: checkedAt,
      task_id: input.pull?.status === "interrupted" ? input.pull.task_id : null,
    };
  }
  if (input.imageRef) {
    return {
      readiness: "ready",
      preparing: false,
      error_code: null,
      error: null,
      checked_at: checkedAt,
      task_id: null,
    };
  }
  return {
    readiness: "unavailable",
    preparing: false,
    error_code: "missing_trusted_digest",
    error: "没有可执行的可信镜像版本。",
    checked_at: checkedAt,
    task_id: null,
  };
}

export function readinessPhase(view: RuntimeImageReadinessView): string {
  if (view.preparing) return "pulling";
  return view.readiness;
}

export function toRuntimeImageStatusEntry(
  imageKey: string,
  imageRef: string | null,
  view: RuntimeImageReadinessView,
): RuntimeImageStatusEntry {
  return {
    image_key: imageKey,
    immutable_ref: imageRef,
    ...view,
    phase: readinessPhase(view),
  };
}

export function assertHubRuntimeImageReady(
  entry: HubRuntimeImageReadinessEntry,
  path = "runtime_image_key",
): void {
  if (entry.readiness === "ready") return;
  throw runtimeImageNotReady(path, {
    image_key: entry.image_key,
    readiness: entry.readiness,
    preparing: entry.preparing,
    error_code: entry.error_code,
    error: entry.error,
    task_id: entry.task_id,
    checked_at: entry.checked_at,
  });
}

export function hostManagesRuntimeImageLayers(): boolean {
  return managesHostDockerRuntime();
}
