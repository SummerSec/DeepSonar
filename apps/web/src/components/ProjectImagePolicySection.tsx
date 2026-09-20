import { FloppyDisk } from "@phosphor-icons/react";
import type { Dispatch, SetStateAction } from "react";
import { SearchableSelect } from "../SearchableSelect";
import { runtimeImageSelectOption } from "../runtime-image-option";
import { HelpTip } from "../ui";
import type { ProjectImageStrategy, RuntimeImageSummary } from "../api";

export function ProjectImagePolicySection({
  projectId,
  imageStrategy,
  setImageStrategy,
  roleRuntimeImages,
  setRoleRuntimeImages,
  imagePolicyRoles,
  globalImageOf,
  projectRuntimeImageChoices,
  imagePolicyBusy,
  imagePolicySaved,
  imagePolicyFailed,
  onSave,
}: {
  projectId: string;
  imageStrategy: ProjectImageStrategy;
  setImageStrategy: (value: ProjectImageStrategy) => void;
  roleRuntimeImages: Record<string, string | null>;
  setRoleRuntimeImages: Dispatch<SetStateAction<Record<string, string | null>>>;
  imagePolicyRoles: Array<{ id: string; name: string; title: string }>;
  globalImageOf: (roleId: string) => string | null | undefined;
  projectRuntimeImageChoices: RuntimeImageSummary[];
  imagePolicyBusy: boolean;
  imagePolicySaved: boolean;
  imagePolicyFailed: boolean;
  onSave: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
      <div className="border-b border-white/[.055] px-4 py-3">
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
          <span>镜像启用与角色缺省</span>
          <HelpTip>
            Hub 可按任务从本项目已启用且可信的镜像中提案；此处只配置启用边界与角色缺省（Hub 省略或非 Hub 建 Job 时使用）。专项镜像须先在项目镜像页启用。
          </HelpTip>
        </div>
      </div>
      <div className="space-y-4 px-4 py-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${imageStrategy === "inherit_global" ? "border-acc-400/50 bg-acc-400/[.06]" : "border-ink-700"}`}>
            <input
              type="radio"
              name={`project-image-strategy-${projectId}`}
              checked={imageStrategy === "inherit_global"}
              onChange={() => setImageStrategy("inherit_global")}
              className="mt-1 accent-emerald-500"
            />
            <span>
              <strong className="block text-[13px] text-zinc-200">继承全局</strong>
              <small className="text-[11px] leading-5 text-zinc-500">缺省跟随各角色全局 RoleConfig 镜像。</small>
            </span>
          </label>
          <label className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${imageStrategy === "project_managed" ? "border-acc-400/50 bg-acc-400/[.06]" : "border-ink-700"}`}>
            <input
              type="radio"
              name={`project-image-strategy-${projectId}`}
              checked={imageStrategy === "project_managed"}
              onChange={() => setImageStrategy("project_managed")}
              className="mt-1 accent-emerald-500"
            />
            <span>
              <strong className="block text-[13px] text-zinc-200">项目托管</strong>
              <small className="text-[11px] leading-5 text-zinc-500">缺省使用下方角色映射；未映射角色用系统基础环境（deepsonar-base）。</small>
            </span>
          </label>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {imagePolicyRoles.map((role) => {
            const globalImage = globalImageOf(role.id);
            const currentImage = roleRuntimeImages[role.name] ?? "";
            return (
              <div key={role.id} className="min-w-0 rounded-md border border-ink-800/80 bg-white/[.02] px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-zinc-300">{role.title || role.name}</div>
                  <div className="truncate font-mono text-[10px] text-zinc-600">{role.name}</div>
                </div>
                {imageStrategy === "inherit_global" ? (
                  <div className="mt-1.5 min-w-0 break-words font-mono text-[11px] leading-5 text-zinc-500">全局镜像：{globalImage ?? "全局未绑定（系统默认）"}</div>
                ) : (
                  <div className="mt-1.5 min-w-0">
                    <SearchableSelect
                      value={currentImage}
                      onChange={(next) => setRoleRuntimeImages((current) => ({ ...current, [role.name]: next || null }))}
                      options={[
                        { value: "", label: "系统基础环境" },
                        ...projectRuntimeImageChoices.map((image) => runtimeImageSelectOption(image, projectId)),
                        ...(currentImage && !projectRuntimeImageChoices.some((image) => image.image_key === currentImage)
                          ? [{ value: currentImage, label: `${currentImage}（当前 · 需检查启用）` }]
                          : []),
                      ]}
                      placeholder="选择运行镜像"
                      ariaLabel={`${role.title || role.name} 的运行镜像`}
                      className="searchable-select-wrap"
                    />
                  </div>
                )}
              </div>
            );
          })}
          {imagePolicyRoles.length === 0 && <div className="col-span-full text-[12px] text-zinc-600">暂无可配置角色。</div>}
        </div>

        <button
          type="button"
          onClick={onSave}
          disabled={imagePolicyBusy}
          className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:cursor-wait disabled:opacity-60"
        >
          <FloppyDisk size={13} /> {imagePolicyBusy ? "保存中…" : imagePolicySaved ? "已保存" : imagePolicyFailed ? "保存失败" : "保存镜像缺省"}
        </button>
      </div>
    </section>
  );
}
