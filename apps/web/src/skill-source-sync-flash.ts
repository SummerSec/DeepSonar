import type { SkillSource } from "./api";

export function formatSkillSourceRegistrationFlash(source: SkillSource & { existing: boolean }): string {
  const trust = source.trust_status === "trusted" ? "已信任" : source.trust_status === "quarantined" ? "隔离中" : source.trust_status === "disabled" ? "已禁用" : "信任状态未知";
  const enabled = source.enabled === undefined ? "启用状态未知" : source.enabled ? "已启用" : "未启用";
  return `${source.existing ? "已复用现有源" : "已登记源"}「${source.name}」：${trust} / ${enabled}；同步只产生待批候选`;
}

export function formatSkillSourceSyncFlash(r: {
  candidate_hash?: string | null;
  changed: boolean;
  modules: number;
  previous_commit_sha?: string | null;
  last_commit_sha?: string | null;
}): string {
  const commit = r.last_commit_sha?.trim().slice(0, 10);
  if (typeof r.candidate_hash === "string" && r.candidate_hash.trim()) {
    return `候选已同步，待批准：${r.candidate_hash}${commit ? ` · commit ${commit}` : ""}，${r.modules} 个模块；已批准目录与权限未改变`;
  }
  if (r.candidate_hash === null) {
    return `已批准 live 目录健康核验完成${commit ? `：commit ${commit}` : ""}，${r.modules} 个模块；没有发布新候选`;
  }
  return "同步请求已完成，但候选状态未知；请刷新源元数据，不能据此判断目录已可用";
}
