import { useParams } from "react-router-dom";
import { SettingsPanel } from "../SettingsPanel";
import { PageHeader } from "../ui";

/** 项目设置：Agent 配置 / 规则 / 模块源（全页，非浮层） */
export function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-ink-800 px-6 pt-5 pb-0">
        <PageHeader
          title="设置"
          subtitle="Agent profile、派生规则与 Git 模块源；变更对下一 job 生效"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SettingsPanel projectId={projectId} variant="page" />
      </div>
    </div>
  );
}
