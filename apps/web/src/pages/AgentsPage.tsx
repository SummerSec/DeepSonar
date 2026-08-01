import { SettingsPanel } from "../SettingsPanel";
import { PageHeader } from "../ui";

/** 全局 Agent 管理：profile / 角色注册表（含系统 prompt 模板）/ 模块源 / 全局规则（§8.1 所有配置落库） */
export function AgentsPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-ink-800 px-6 pt-5 pb-0">
        <PageHeader
          title="Agent 管理"
          subtitle="全局维护 Agent 配置、角色与 prompt 模板、Git 模块源与全局规则；项目设置只负责启用与绑定"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SettingsPanel projectId={null} variant="page" />
      </div>
    </div>
  );
}
