import { SettingsPanel } from "../SettingsPanel";
import { PageHeader } from "../ui";

/** Agent 能力定义：角色注册表与全局运行配置，不承载平台治理。 */
export function AgentsPage() {
  return (
    <div className="agents-page flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto">
      <div className="agents-page-header w-full max-w-[1320px] shrink-0 px-5 pt-7 sm:px-9 sm:pt-9">
        <PageHeader
          title="Agent 管理"
          eyebrow="AGENT GOVERNANCE"
        />
      </div>
      <div className="min-h-0 flex-none [&_.settings-content]:flex-none [&_.settings-content]:overflow-visible [&_.settings-panel]:h-auto">
        <SettingsPanel projectId={null} variant="page" globalSection="agents" />
      </div>
    </div>
  );
}
