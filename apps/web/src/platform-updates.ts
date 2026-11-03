/** #740 P1 slice 2：平台版本发现提示（GET /platform/updates，仅管理员）。 */
export type PlatformUpdateStatus = {
  checked_at: string | null;
  current_version: string;
  available_version: string | null;
  available_commit_sha: string | null;
  available_schema_version: number | null;
  changelog_url: string | null;
  update_available: boolean;
  schema_rebuild_needed: boolean;
  check_error: string | null;
  registry_source: string | null;
  missing: boolean;
};

export type PlatformUpdatePrompt = {
  kind: "available" | "error";
  title: string;
  detail: string;
  changelog_url: string | null;
};

/** Admin-only prompt. Non-admins never call the API; this helper returns null when idle. */
export function platformUpdatePrompt(status: PlatformUpdateStatus | null | undefined): PlatformUpdatePrompt | null {
  if (!status || status.missing) return null;
  if (status.check_error) {
    return {
      kind: "error",
      title: "平台版本检查失败",
      detail: status.check_error,
      changelog_url: null,
    };
  }
  if (!status.update_available || !status.available_version) return null;
  const parts = [`当前 ${status.current_version || "未知"} → 可用 ${status.available_version}`];
  if (status.schema_rebuild_needed) {
    parts.push(`需 schema 重建（目标 v${status.available_schema_version ?? "?"}）`);
  }
  // Host upgrade is shipped (#740 P1/P2, v0.6.0+); only the optional
  // web-initiated upgrade is unimplemented, so the prompt must not claim
  // otherwise and must not suggest a bare `upgrade` that lacks an action.
  const target = `v${status.available_version}`;
  parts.push(`在宿主机受控升级：先 ./deploy/deploy.sh upgrade check --to ${target} 并审核阻断项与风险，`
    + `再 ./deploy/deploy.sh upgrade apply --to ${target}（有风险时附 --approve-plan-hash <本次计划哈希>）`);
  parts.push("Web 只提示版本，不代执行升级；步骤见 deploy/README.md 的受控升级章节");
  return {
    kind: "available",
    title: `发现平台新版本 ${status.available_version}`,
    detail: parts.join(" · "),
    changelog_url: status.changelog_url,
  };
}
