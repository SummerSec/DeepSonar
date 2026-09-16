/** Format frozen Job snapshot model fields for operators (#570). */
export function formatSnapshotModelField(
  model: string,
  upstreamModel: string,
): { modelLabel: string; upstreamLabel: string; title?: string } {
  const CLI_DEFAULT_PREFIX = "cli-default:";
  if (upstreamModel.startsWith(CLI_DEFAULT_PREFIX)) {
    const name = upstreamModel.slice(CLI_DEFAULT_PREFIX.length) || "—";
    return {
      modelLabel: model === "—" || !model ? "未指定" : model,
      upstreamLabel: `未指定 → CLI 默认 ${name}（经凭据 alias 转发，实际模型不可观测）`,
      title: "RoleConfig / settings 未指定 model 时冻结的 CLI 内置默认；上游可能经凭据 alias 映射，台账 model 仍为请求协议值。",
    };
  }
  return { modelLabel: model, upstreamLabel: upstreamModel };
}
