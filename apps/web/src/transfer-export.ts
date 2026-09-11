/**
 * 项目数据包导出：preset / 自定义模块与后端 transfer 契约对齐。
 * 可选模块与 `apps/scheduler/src/transfer/modules.ts` 的 CUSTOM_EXPORT_MODULES 同步。
 */
export const PROJECT_PRESETS = [
  { id: "configuration" as const, label: "配置模板", hint: "规则 / 角色 / Skill / 环境（无任务历史）" },
  { id: "project_full" as const, label: "完整项目", hint: "含任务、Finding、事件；要求无活动 Job，不可客户端豁免" },
  { id: "evidence_archive" as const, label: "证据归档", hint: "允许活动 Job；含任务、Finding、事件与审计（一致快照）" },
  { id: "custom" as const, label: "自定义模块", hint: "自选已实现模块；任务/Finding 需无活动 Job；仅勾选事件时可显式允许" },
] as const;

export type ProjectExportPreset = (typeof PROJECT_PRESETS)[number]["id"];

export const PROJECT_EXPORT_MODULES = [
  { id: "rules", label: "规则", hint: "项目规则与协议覆盖" },
  { id: "roles", label: "角色", hint: "角色注册与项目 RoleConfig" },
  { id: "skills", label: "模块源", hint: "Skill / 插件源引用（导入后需重新审批）" },
  { id: "runtime_images", label: "运行镜像", hint: "项目镜像策略引用" },
  { id: "environment", label: "环境变量", hint: "env_keys 与已脱敏值，不含 Secret" },
  { id: "credentials", label: "凭据元数据", hint: "仅名称 / provider / 指纹，不含明文" },
  { id: "tasks", label: "任务", hint: "画布、Job、节点；有活动 Job 时需改用证据归档" },
  { id: "findings", label: "Finding", hint: "已提交 Finding；有活动 Job 时需改用证据归档" },
  { id: "events", label: "事件", hint: "语义事件流；可显式允许活动 Job，达上限会标记截断" },
  { id: "audit_archive", label: "审计归档", hint: "项目审计日志（脱敏）" },
] as const;

export type ProjectExportModuleId = (typeof PROJECT_EXPORT_MODULES)[number]["id"];

export function defaultProjectExportModules(): Set<ProjectExportModuleId> {
  return new Set<ProjectExportModuleId>(["findings"]);
}

export function projectExportAllowsActiveJobs(
  preset: ProjectExportPreset,
  selectedModules?: ReadonlySet<ProjectExportModuleId>,
): boolean {
  if (preset === "evidence_archive") return true;
  return preset === "custom" && Boolean(selectedModules?.has("events"));
}

export function buildProjectExportRequest(
  preset: ProjectExportPreset,
  selectedModules: ReadonlySet<ProjectExportModuleId>,
): {
  preset: ProjectExportPreset;
  modules?: ProjectExportModuleId[];
  allow_active_jobs: boolean;
  credentials: { mode: "excluded" | "metadata" };
} {
  if (preset !== "custom") {
    return {
      preset,
      allow_active_jobs: projectExportAllowsActiveJobs(preset),
      credentials: { mode: "metadata" },
    };
  }
  const modules = PROJECT_EXPORT_MODULES.map((m) => m.id).filter((id) => selectedModules.has(id));
  return {
    preset: "custom",
    modules,
    allow_active_jobs: projectExportAllowsActiveJobs("custom", selectedModules),
    credentials: { mode: modules.includes("credentials") ? "metadata" : "excluded" },
  };
}
