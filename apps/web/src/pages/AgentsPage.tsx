import { SettingsPanel } from "../SettingsPanel";
import { PageHeader } from "../ui";

/** 全局 Agent 管理：角色注册表（含全局缺省运行配置与系统 prompt 模板）/ 模块源 / 全局规则（§8.1 所有配置落库） */
export function AgentsPage() {
  return (
    <div className="agents-page flex min-h-full flex-col overflow-x-hidden overflow-y-auto">
      <div className="agents-page-header w-full max-w-[1320px] shrink-0 px-5 pt-7 sm:px-9 sm:pt-9">
        <PageHeader
          title="Agent 管理"
          eyebrow="AGENT GOVERNANCE"
          subtitle="在全局定义角色能力、可信运行配置与模块来源；项目只选择启用哪些角色，并在必要时覆盖缺省值。"
        />
      </div>
      <div className="min-h-0 flex-none [&_.settings-content]:flex-none [&_.settings-content]:overflow-visible [&_.settings-panel]:h-auto">
        <SettingsPanel projectId={null} variant="page" />
      </div>
    </div>
  );
}
