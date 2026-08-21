import type { RuntimeImagePullItem, RuntimeImagePullTask } from "./api";

export function pullPurposeLabel(purpose?: string): string {
  if (!purpose) return "镜像准备";
  if (purpose.startsWith("project_binding:")) return "项目启用";
  if (purpose.startsWith("registry_channel:")) return "仓库通道切换";
  if (purpose === "admin_bulk") return "注册表预热";
  return purpose;
}

export function pullItemStatusLabel(status: RuntimeImagePullItem["status"] | RuntimeImagePullTask["status"]): string {
  if (status === "queued") return "排队";
  if (status === "running") return "拉取中";
  if (status === "succeeded") return "成功";
  if (status === "failed") return "失败";
  return "空闲";
}

export function pullHeadline(task: RuntimeImagePullTask): string {
  if (task.status === "succeeded") return "拉取完成，可再次启用";
  if (task.status === "failed") return "拉取完成，但有失败项";
  if (task.status === "queued" || task.status === "running") {
    return `拉取进度 ${task.completed}/${task.total}`;
  }
  return "暂无拉取任务";
}

export function shortImageRef(ref: string): string {
  const match = ref.match(/@sha256:([a-fA-F0-9]+)/);
  if (match) return `sha256:${match[1].slice(0, 12)}`;
  return ref.length > 52 ? `${ref.slice(0, 28)}…${ref.slice(-12)}` : ref;
}

export function formatPullElapsed(startedAt: string | null, finishedAt: string | null, nowMs = Date.now()): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : nowMs;
  if (!Number.isFinite(end)) return null;
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function isRuntimeImagePullBusyError(message: string): boolean {
  return /runtime_image_preparation_busy|already running/i.test(message);
}

export function projectBindingDeferredNotice(imageName: string): string {
  return `正在后台准备 ${imageName}；绑定尚未保存，拉完后再启用`;
}

export function projectBindingBusyNotice(task: RuntimeImagePullTask | null): string {
  if (!task || task.status === "idle") {
    return "当前已有镜像拉取任务在运行，请等待完成后再启用";
  }
  return `当前拉取任务未完成（${pullPurposeLabel(task.purpose)} ${task.completed}/${task.total}），请等待完成后再启用`;
}

export function registryChannelDeferredNotice(channelLabel: string, total: number): string {
  return `正在后台准备 ${channelLabel} 的 ${total} 个镜像；当前通道未切换，完成后会自动保存`;
}

export function registryChannelBusyNotice(task: RuntimeImagePullTask | null): string {
  if (!task || task.status === "idle") {
    return "当前已有镜像拉取任务在运行，完成后会自动切换通道";
  }
  return `当前拉取任务未完成（${pullPurposeLabel(task.purpose)} ${task.completed}/${task.total}），完成后会自动切换通道`;
}

export function registryChannelSelectValue(
  pendingChannel: string | null | undefined,
  selectedChannel: string | null | undefined,
): string {
  return pendingChannel || selectedChannel || "";
}

export function isRegistryChannelSwitchLocked(
  pendingChannel: string | null | undefined,
  pullStatus: Pick<RuntimeImagePullTask, "status"> | null | undefined,
  busy: string | null | undefined,
): boolean {
  if (busy === "registry-channel") return true;
  if (!pendingChannel) return false;
  return pullStatus?.status === "queued" || pullStatus?.status === "running";
}
