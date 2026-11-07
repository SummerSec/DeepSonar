/** #953: server-authoritative project availability; draft flags never grant access. */
import type { ProjectSkillSourceBinding, SkillSource } from "./api";

export type SkillSourceTone = "ready" | "pending" | "blocked" | "off";
export interface SkillSourceReadiness {
  tone: SkillSourceTone;
  label: string;
  blockers: string[];
  nextStep: string | null;
  /** Only persisted project flags and the approved catalog determine usability. */
  usable: boolean;
}
export interface SkillSourceReadinessInput {
  source: ProjectSkillSourceBinding;
  /** Draft value, used only to describe an unsaved change. */
  projectEnabled: boolean;
}

export function hasUsableCatalog(source: ProjectSkillSourceBinding): boolean {
  return source.module_count > 0 && /^[a-f0-9]{64}$/i.test(source.catalog_snapshot_hash ?? "");
}

export function describeSkillSourceReadiness({ source, projectEnabled }: SkillSourceReadinessInput): SkillSourceReadiness {
  const blockers: string[] = [];
  if (source.trust_status === "disabled") {
    blockers.push("平台已禁用该源（不能同步，也不能下发）");
  } else if (source.trust_status !== "trusted") {
    blockers.push("待平台信任：登记成功不等于已审核，需要批准后才能下发");
  }
  if (source.trust_status !== "disabled" && !source.source_enabled) {
    blockers.push("平台未启用该源，Job 不会读取它的目录");
  }
  if (!hasUsableCatalog(source)) {
    blockers.push(source.module_count <= 0
      ? "没有可用 Skill：尚无非空已批准目录（SKILL.md 或 commands/*.md）"
      : "缺少有效的已批准目录摘要，不能下发候选内容");
  }
  if (!source.project_enabled) blockers.push("本项目未启用该源");
  const usable = blockers.length === 0;
  const pending = projectEnabled !== source.project_enabled;
  const nextStep = (() => {
    if (source.trust_status === "disabled") return "由平台管理员恢复该源并重新同步审批";
    if (!hasUsableCatalog(source)) return "由有平台级 skills:write 权限的账号同步候选，检查 SKILL.md 后批准目录";
    if (source.trust_status !== "trusted") return "由有平台级 skills:write 权限的账号批准信任";
    if (!source.source_enabled) return "由有平台级 skills:write 权限的账号在平台启用该源";
    if (pending) return `${projectEnabled ? "启用" : "停用"}待保存（仅影响之后创建的 Job）`;
    if (!source.project_enabled) return "勾选本项目启用并保存（仅影响之后创建的 Job）";
    return null;
  })();
  const label = usable ? "本项目可用"
    : source.trust_status === "disabled" ? "平台已禁用"
      : source.trust_status !== "trusted" ? "待平台信任"
        : !source.source_enabled ? "平台未启用"
          : !hasUsableCatalog(source) ? "无可用 Skill"
            : "本项目已停用";
  return {
    tone: usable ? "ready" : source.trust_status === "disabled" ? "blocked" : "pending",
    label, blockers, nextStep, usable,
  };
}

export function skillSourceWritePermissionHint(canProjectWrite: boolean, canManagePlatform: boolean): string | null {
  if (!canProjectWrite) return "当前账号缺少 skills:write 权限：只能查看，不能修改项目启停设置，也不能登记、同步或审批全局 Skill 源。请联系管理员。";
  if (!canManagePlatform) return "当前令牌限定到项目：可以保存本项目启停设置，但登记、同步、审批和启停全局 Skill 源需要未限定项目的全局 skills:write 权限。请联系平台管理员。";
  return null;
}

export function skillSourceRegisteredHint(source: Pick<SkillSource, "name" | "trust_status" | "enabled">): string {
  const trust = source.trust_status === "quarantined" ? "仍是隔离状态" : source.trust_status ?? "信任状态未知";
  const enabled = source.enabled === true ? "平台已启用" : source.enabled === false ? "平台未启用" : "平台启用状态未知";
  return `已登记「${source.name}」（${trust}，${enabled}）。需要有效已批准目录与平台信任并启用；届时所有未显式停用该源的项目未来新 Job 可见，登记本身不授权。`;
}
