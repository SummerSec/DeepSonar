import type { RuntimeImageSummary } from "./api";
import type { SelectOption } from "./searchable-select-model";

export function runtimeImageKindHint(
  image: Pick<RuntimeImageSummary, "image_key" | "official" | "project_opt_in" | "project_enabled">,
  projectId: string | null,
): string {
  const kind = image.image_key === "deepsonar-base"
    ? "底座"
    : image.official
      ? image.project_opt_in
        ? "专项·项目启用"
        : "专项"
      : "第三方";
  const needsProject = image.official && image.project_opt_in && projectId && image.project_enabled !== true
    ? "未在项目启用"
    : image.official && image.project_opt_in && !projectId
      ? "运行前需项目启用"
      : "";
  return needsProject ? `${kind} · ${needsProject}` : kind;
}

export function runtimeImageOptionLabel(
  image: Pick<RuntimeImageSummary, "name" | "image_key" | "official" | "project_opt_in" | "project_enabled">,
  projectId: string | null,
): string {
  return `${image.name} · ${runtimeImageKindHint(image, projectId)}`;
}

export function isRuntimeImagePinStale(
  image: Pick<RuntimeImageSummary, "pin_stale" | "selected_version_id">,
): boolean {
  return Boolean(image.pin_stale && image.selected_version_id);
}

export function runtimeImagePinLabel(
  image: Pick<RuntimeImageSummary, "selected_version_id" | "selected_version" | "latest_version" | "pin_stale"> &
    Partial<Pick<RuntimeImageSummary, "official" | "pin_policy">>,
): string {
  if (!image.selected_version_id) return "自动（跟随最新 trusted）";
  const pin = image.selected_version ?? "已选版本";
  if (image.pin_policy === "hold") {
    return image.pin_stale ? `固定 ${pin} · 保持 · 已过期` : `固定 ${pin} · 保持`;
  }
  if (image.pin_stale) return `固定 ${pin} · 已过期`;
  if (image.official && image.latest_version && image.selected_version === image.latest_version) {
    return `已随官方升到 ${pin}`;
  }
  if (image.latest_version && image.selected_version && image.selected_version !== image.latest_version) {
    return `固定 ${pin} · 最新 ${image.latest_version}`;
  }
  return `固定 ${pin}`;
}

export function runtimeImageSelectOption(
  image: Pick<RuntimeImageSummary, "name" | "image_key" | "official" | "project_opt_in" | "project_enabled">,
  projectId: string | null,
  disabled = false,
): SelectOption {
  const hint = runtimeImageKindHint(image, projectId);
  return {
    value: image.image_key,
    label: image.name,
    hint,
    keywords: [image.image_key, hint],
    disabled,
  };
}
