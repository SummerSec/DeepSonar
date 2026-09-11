/**
 * 项目数据包模块定义（模块/预设见本文件与 DESIGN.md「transfer」段）
 */

export const FORMAT = "deepsonar-project-export";
export const FORMAT_VERSION = "1.0";

/** 各模块逻辑数据契约版本；tasks v2 增加 Fact verification_status。 */
export function moduleVersion(module: ModuleKey): number {
  return module === "tasks" ? 2 : 1;
}

export type ModuleKey =
  | "project"
  | "rules"
  | "roles"
  | "skills"
  | "runtime_images"
  | "environment"
  | "tasks"
  | "events"
  | "findings"
  | "audit_archive"
  | "credentials";

export type Preset =
  | "configuration"
  | "project_full"
  | "evidence_archive"
  | "custom";

export const MODULE_DEPS: Record<ModuleKey, ModuleKey[]> = {
  project: [],
  rules: ["project"],
  roles: ["project"],
  skills: ["roles"],
  runtime_images: ["roles"],
  environment: ["roles"],
  tasks: ["project"],
  events: ["tasks"],
  findings: ["tasks"],
  audit_archive: ["project"],
  credentials: ["roles"],
};

const PRESETS: Record<Exclude<Preset, "custom">, ModuleKey[]> = {
  configuration: [
    "project",
    "rules",
    "roles",
    "skills",
    "runtime_images",
    "environment",
    "credentials",
  ],
  project_full: [
    "project",
    "rules",
    "roles",
    "skills",
    "runtime_images",
    "environment",
    "credentials",
    "tasks",
    "events",
    "findings",
    "audit_archive",
  ],
  evidence_archive: [
    "project",
    "tasks",
    "findings",
    "events",
    "audit_archive",
  ],
};

/**
 * 自定义导出可选模块。只含已实现 collect+import 的模块；`project` 由 resolveModules 自动补齐。
 */
export const CUSTOM_EXPORT_MODULES = [
  "rules",
  "roles",
  "skills",
  "runtime_images",
  "environment",
  "credentials",
  "tasks",
  "findings",
  "events",
  "audit_archive",
] as const satisfies readonly ModuleKey[];

const CUSTOM_EXPORT_MODULE_SET: ReadonlySet<string> = new Set(CUSTOM_EXPORT_MODULES);

/** 自定义导出中不在白名单的 selector（保序去重）。 */
export function rejectedCustomExportModules(modules: readonly string[] | undefined): string[] {
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const value of modules ?? []) {
    if (CUSTOM_EXPORT_MODULE_SET.has(value) || seen.has(value)) continue;
    seen.add(value);
    rejected.push(value);
  }
  return rejected;
}

export function unknownExportModulesError(rejected: readonly string[]): {
  error: string;
  error_code: "UNKNOWN_EXPORT_MODULES";
  rejected: string[];
} {
  return {
    error: `不接受的导出模块: ${rejected.join(", ")}`,
    error_code: "UNKNOWN_EXPORT_MODULES",
    rejected: [...rejected],
  };
}

/** 自定义导出或显式 modules 含白名单外 selector 时返回 400 载荷。 */
export function rejectUnknownProjectExportModules(
  preset: unknown,
  modules: unknown,
): ReturnType<typeof unknownExportModulesError> | null {
  const requested = Array.isArray(modules)
    ? modules.filter((value): value is string => typeof value === "string")
    : undefined;
  if (preset !== "custom" && !requested) return null;
  const rejected = rejectedCustomExportModules(requested);
  return rejected.length ? unknownExportModulesError(rejected) : null;
}

export function resolveModules(
  preset: Preset,
  modules?: string[],
): { modules: ModuleKey[]; autoAdded: ModuleKey[] } {
  let selected: ModuleKey[];
  if (preset === "custom") {
    selected = (modules ?? []).filter((m): m is ModuleKey => CUSTOM_EXPORT_MODULE_SET.has(m));
  } else {
    selected = [...PRESETS[preset]];
  }
  if (!selected.includes("project")) selected = ["project", ...selected];

  const set = new Set<ModuleKey>(selected);
  const autoAdded: ModuleKey[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of [...set]) {
      if (!Object.hasOwn(MODULE_DEPS, m)) continue;
      for (const d of MODULE_DEPS[m]) {
        if (!set.has(d)) {
          set.add(d);
          autoAdded.push(d);
          changed = true;
        }
      }
    }
  }
  // 稳定顺序
  const order = Object.keys(MODULE_DEPS) as ModuleKey[];
  return {
    modules: order.filter((m) => set.has(m)),
    autoAdded: [...new Set(autoAdded)],
  };
}

/** 配置类模块（允许 merge_configuration） */
export const CONFIG_MODULES = new Set<ModuleKey>([
  "project",
  "rules",
  "roles",
  "skills",
  "runtime_images",
  "environment",
  "credentials",
]);

/**
 * 运行中 Job 会持续追加的模块。导出它们等于把进行中会话当成一致快照。
 * findings / 已提交画布与 Job 行是落库只读数据；Job 运行态字段在收集时已剥掉。
 */
export const LIVE_STREAM_MODULES: ReadonlySet<ModuleKey> = new Set(["events"]);

export function isConfigOnly(modules: ModuleKey[]): boolean {
  return modules.every((m) => CONFIG_MODULES.has(m));
}

/** 完整一致性拷贝，或含进行中事件流时，默认要求项目没有活动 Job。 */
export function exportRequiresQuietProject(
  preset: Preset,
  modules: readonly ModuleKey[],
  allowActiveJobs = false,
): boolean {
  if (allowActiveJobs) return false;
  if (preset === "project_full") return true;
  return modules.some((m) => LIVE_STREAM_MODULES.has(m));
}

export function activeJobsErrorMessage(activeCount: number): string {
  return (
    `项目存在 ${activeCount} 个活动 Job。完整项目导出需要任务全部结束后才能保证一致性。` +
    "可改用：配置模板（无任务数据）、证据归档（允许活动 Job，含任务/Finding/事件）、" +
    "或自定义模块导出已提交的 Finding/任务结果；也可等待结束或取消活动任务。"
  );
}
