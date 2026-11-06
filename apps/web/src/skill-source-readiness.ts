/**
 * #953：项目「Skill 源」面板的状态推导。
 *
 * 登记 ≠ 已可运行：一条源要经过 平台信任 → 平台启用 → 同步出目录 → 本项目启用
 * 四道门才可能进入下一 Job 的冻结快照。这里把每道门落成可读的阻塞原因，
 * 供面板展示，避免把「登记成功」「同步成功」写成「已可用」。
 *
 * 纯函数，不读 React/DOM，便于在 CI 里直接断言。
 */
import type { ProjectSkillSourceBinding } from "./api";

export type SkillSourceTone = "ready" | "pending" | "blocked" | "off";

export interface SkillSourceReadiness {
  tone: SkillSourceTone;
  /** 一句话状态（面板徽章） */
  label: string;
  /** 仍然阻塞该源进入下一 Job 的原因，按准入顺序列出 */
  blockers: string[];
  /** 用户此时最该做的一件事；已可用或纯展示时为 null */
  nextStep: string | null;
  /** 是否真正可被下一 Job 使用（平台 trusted+enabled 且目录非空 且 本项目启用） */
  usable: boolean;
}

export interface SkillSourceReadinessInput {
  source: ProjectSkillSourceBinding;
  /** 表单中该项目启用勾选的当前值（未保存的 draft 优先） */
  projectEnabled: boolean;
}

/** 平台目录里是否有可用模块（同步过且扫描出 SKILL.md/commands）。 */
export function hasUsableCatalog(source: ProjectSkillSourceBinding): boolean {
  return source.module_count > 0;
}

export function describeSkillSourceReadiness(
  input: SkillSourceReadinessInput,
): SkillSourceReadiness {
  const { source, projectEnabled } = input;
  const blockers: string[] = [];

  if (source.trust_status === "disabled") {
    blockers.push("平台已禁用该源（不能同步，也不能下发）");
  } else if (source.trust_status !== "trusted") {
    blockers.push("待平台信任：登记成功不等于已审核，需要批准后才能下发");
  }
  if (source.trust_status !== "disabled" && !source.source_enabled) {
    blockers.push("平台未启用该源，Job 不会读取它的目录");
  }
  if (!source.synced_at) {
    blockers.push("尚未同步：平台还没有该仓库的目录副本");
  } else if (!hasUsableCatalog(source)) {
    blockers.push("同步完成但仓库内没有可用 Skill（未扫描到 SKILL.md 或 commands/*.md）");
  }
  if (!projectEnabled) {
    blockers.push("本项目未启用该源");
  }

  const usable = blockers.length === 0;
  if (usable) {
    return { tone: "ready", label: "本项目可用", blockers: [], nextStep: null, usable: true };
  }

  const nextStep = (() => {
    if (source.trust_status === "disabled") return "由平台管理员在「模块源」恢复该源";
    if (source.trust_status !== "trusted") return "有 skills:write 权限的用户在此点击「批准信任」";
    if (!source.source_enabled) return "在平台「模块源」启用该源（信任与启用是两个门）";
    if (!source.synced_at) return "点击「同步」拉取目录";
    if (!hasUsableCatalog(source)) return "检查仓库内是否有 SKILL.md 或 commands/*.md，然后重新同步";
    return "勾选本项目启用并保存（仅影响之后创建的 Job）";
  })();

  const tone: SkillSourceTone = source.trust_status === "disabled" ? "blocked" : "pending";
  const label = !projectEnabled && blockers.length === 1
    ? "本项目已停用"
    : source.trust_status === "disabled"
      ? "平台已禁用"
      : source.trust_status !== "trusted"
        ? "待平台信任"
        : !source.source_enabled
          ? "平台未启用"
          : !source.synced_at
            ? "未同步"
            : !hasUsableCatalog(source)
              ? "无可用 Skill"
              : "已就绪待启用";

  return { tone, label, blockers, nextStep, usable: false };
}

/** 权限不足时给用户的具体下一步（面板顶部只读提示）。 */
export function skillSourceWritePermissionHint(canWrite: boolean): string | null {
  if (canWrite) return null;
  return "当前账号缺少 skills:write 权限：可以查看状态，但不能登记、同步或信任 Skill 源。请让管理员在「账号」里为该账号或令牌加上 skills:write。";
}

/** 登记成功后的提示：明确写出还差什么，不表述成「已可运行」。 */
export function skillSourceRegisteredHint(name: string): string {
  return `已登记「${name}」。它现在仍是隔离状态：需要同步 → 批准信任 → 平台启用 → 在本项目勾选启用，才会进入之后创建的 Job。`;
}