/** Navigation uses only caller-visible project references returned by credential impact. */
export function ProjectCredentialRepairLinks({ references }: {
  references: { count: number; items: Array<{ project_id: string; project_name: string | null; enabled: boolean; default: boolean }> };
}) {
  if (references.count === 0) return null;
  return <details className="provider-flow-error" open>
    <summary>{references.count} 个项目需要修复账号引用</summary>
    <ul>{references.items.map((reference) => <li key={reference.project_id}>
      <a className="underline" href={`/projects/${encodeURIComponent(reference.project_id)}/settings?tab=roles`}>
        {reference.project_name || reference.project_id} · 账号设置
      </a>
      {"（"}{[reference.enabled && "启用账号", reference.default && "默认账号"].filter(Boolean).join("、")}{"）"}
    </li>)}</ul>
    {references.count > references.items.length && <p>仅显示前 {references.items.length} 项，其余项目请管理员处理。</p>}
    <p>请明确移除或更换引用并保存，再返回此页重试删除。此入口不修改历史 Job 或自动重跑。</p>
  </details>;
}
