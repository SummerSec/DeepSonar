import { useParams } from "react-router-dom";
import { SettingsPanel } from "../SettingsPanel";
import { PageHeader } from "../ui";

/** 项目设置：规则覆盖 / profile 绑定 / 角色启用（Agent 配置与模板在全局「Agent 管理」页维护） */
export function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-ink-800 px-6 pt-5 pb-0">
        <PageHeader
          title="设置"
          subtitle="本项目只负责启用与绑定：规则覆盖、profile 绑定、角色启用；Agent 配置与模板在「Agent 管理」页维护"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SettingsPanel projectId={projectId} variant="page" />
      </div>
    </div>
  );
}
