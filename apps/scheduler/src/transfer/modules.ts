/**
 * 项目数据包模块定义（docs/TODO_DATABASE_IMPORT_EXPORT_PLAN.md §4）
 */

export const FORMAT = "deepsonar-project-export";
export const FORMAT_VERSION = "1.0";

export type ModuleKey =
  | "project"
  | "rules"
  | "roles"
  | "skills"
  | "runtime_images"
  | "environment"
  | "integrations"
  | "tasks"
  | "canvas_broadcasts"
  | "events"
  | "findings"
  | "reports"
  | "artifacts"
  | "audit_archive"
  | "credentials";

export type Preset = "configuration" | "project_full" | "evidence_archive" | "custom";

export const MODULE_DEPS: Record<ModuleKey, ModuleKey[]> = {
  project: [],
  rules: ["project"],
  roles: ["project"],
  skills: ["roles"],
  runtime_images: ["roles"],
  environment: ["roles"],
  integrations: ["project"],
  tasks: ["project"],
  canvas_broadcasts: ["tasks"],
  events: ["tasks"],
  findings: ["tasks"],
  reports: ["tasks", "findings"],
  artifacts: ["tasks"],
  audit_archive: ["project"],
  credentials: ["roles"],
};

const PRESETS: Record<Exclude<Preset, "custom">, ModuleKey[]> = {
  configuration: ["project", "rules", "roles", "skills", "runtime_images", "environment", "integrations", "credentials"],
  project_full: [
    "project",
    "rules",
    "roles",
    "skills",
    "runtime_images",
    "environment",
    "integrations",
    "credentials",
    "tasks",
    "canvas_broadcasts",
    "events",
    "findings",
    "artifacts",
    "audit_archive",
  ],
  evidence_archive: ["project", "tasks", "canvas_broadcasts", "findings", "events", "artifacts", "audit_archive"],
};

export function resolveModules(preset: Preset, modules?: string[]): { modules: ModuleKey[]; autoAdded: ModuleKey[] } {
  let selected: ModuleKey[];
  if (preset === "custom") {
    selected = (modules ?? []).filter((m): m is ModuleKey => m in MODULE_DEPS);
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
  return { modules: order.filter((m) => set.has(m)), autoAdded: [...new Set(autoAdded)] };
}

/** 配置类模块（允许 merge_configuration） */
export const CONFIG_MODULES = new Set<ModuleKey>([
  "project",
  "rules",
  "roles",
  "skills",
  "runtime_images",
  "environment",
  "integrations",
  "credentials",
]);

export function isConfigOnly(modules: ModuleKey[]): boolean {
  return modules.every((m) => CONFIG_MODULES.has(m));
}
