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
