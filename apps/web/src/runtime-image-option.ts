import { officialRuntimeImageNotIncludedOneLiner } from "./runtime-image-boundary";
import type { RuntimeImageSummary } from "./api";
import type { SelectOption } from "./searchable-select-model";

/**
 * #691 project availability (UI mirror of scheduler helper):
 * - deepsonar-base: always available
 * - other official: available unless project_enabled === false
 * - third-party: requires project_enabled === true (platform visibility enforced server-side)
 */
export function isProjectRuntimeImageAvailable(
  image: Pick<RuntimeImageSummary, "official" | "project_enabled" | "image_key">,
): boolean {
  if (image.image_key === "deepsonar-base") return true;
  return image.official
    ? image.project_enabled !== false
    : image.project_enabled === true;
}

export function runtimeImageKindHint(
  image: Pick<RuntimeImageSummary, "image_key" | "official" | "project_opt_in" | "project_enabled">,
  projectId: string | null,
): string {
  const kind = image.image_key === "deepsonar-base"
    ? "底座"
    : image.official
      ? "专项"
      : "第三方";
  if (image.image_key === "deepsonar-base") return kind;
  if (image.official) {
    if (projectId && image.project_enabled === false) return `${kind} · 已在项目排除`;
    return kind;
  }
  const needsProject = projectId && image.project_enabled !== true
    ? "未在项目启用"
    : !projectId
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

/** @deprecated #691: project pins removed; kept for residual callers. */
export function isRuntimeImagePinStale(
  _image: Pick<RuntimeImageSummary, "pin_stale" | "selected_version_id">,
): boolean {
  return false;
}

export function isRuntimeImageBelowPlatformMin(
  image: Pick<RuntimeImageSummary, "below_platform_min">,
): boolean {
  return image.below_platform_min === true;
}

/** @deprecated #691: project pins removed. */
export function runtimeImagePinLabel(
  _image: Pick<RuntimeImageSummary, "selected_version_id" | "selected_version" | "latest_version" | "pin_stale"> &
    Partial<Pick<RuntimeImageSummary, "official" | "pin_policy">>,
): string {
  return "跟随平台最新 trusted";
}

export function runtimeImageSelectOption(
  image: Pick<RuntimeImageSummary, "name" | "image_key" | "official" | "project_opt_in" | "project_enabled">,
  projectId: string | null,
  disabled = false,
): SelectOption {
  const kind = runtimeImageKindHint(image, projectId);
  const notIncluded = officialRuntimeImageNotIncludedOneLiner(image.image_key);
  const hint = notIncluded ? `${kind} · 不包含：${notIncluded}` : kind;
  return {
    value: image.image_key,
    label: image.name,
    hint,
    keywords: [image.image_key, kind, hint, notIncluded ?? ""].filter(Boolean),
    disabled,
  };
}
