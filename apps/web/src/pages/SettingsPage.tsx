import { useParams } from "react-router-dom";
import { SettingsPanel } from "../SettingsPanel";
import { PageHeader } from "../ui";

/** 项目设置：规则覆盖 / 角色启用与运行配置覆盖（Agent 配置与模板在全局「Agent 管理」页维护） */
export function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-7 sm:px-9 sm:pt-9">
        <PageHeader
          title="项目策略"
          eyebrow="PROJECT POLICY"
          subtitle="这里只定义本项目与全局缺省的差异：启用角色、覆盖运行配置、调整规则与可选集成。"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SettingsPanel projectId={projectId} variant="page" />
      </div>
    </div>
  );
}
