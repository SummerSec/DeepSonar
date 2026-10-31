export function formatSkillSourceSyncFlash(r: {
  changed: boolean;
  modules: number;
  previous_commit_sha?: string | null;
  last_commit_sha?: string | null;
}): string {
  const short = (sha?: string | null) => (sha && sha.trim() ? sha.trim().slice(0, 10) : "");
  const next = short(r.last_commit_sha);
  const prev = short(r.previous_commit_sha);
  if (!r.changed) {
    return next ? `已是最新：commit ${next}，${r.modules} 个模块` : "已是最新，目录未变化";
  }
  if (prev && next && prev !== next) {
    return `已更新 commit ${prev} → ${next}，${r.modules} 个模块`;
  }
  if (next) return `已更新到 commit ${next}，${r.modules} 个模块`;
  return `已更新，${r.modules} 个模块`;
}
