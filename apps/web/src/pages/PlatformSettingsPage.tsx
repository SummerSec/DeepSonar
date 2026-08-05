import { Database, Key, ShieldCheck } from "@phosphor-icons/react";
import { Navigate, NavLink, useParams } from "react-router-dom";
import { SettingsPanel, type GlobalSettingsSection } from "../SettingsPanel";
import { useAuth } from "../auth";
import { canAccessAnyScope } from "../permissions";
import { PageHeader } from "../ui";

const SECTIONS: Record<string, {
  title: string;
  eyebrow: string;
  subtitle: string;
  section: GlobalSettingsSection;
  icon: typeof ShieldCheck;
  scopes: string[];
}> = {
  access: {
    title: "安全与访问",
    eyebrow: "PLATFORM / IAM",
    subtitle: "管理个人账号、平台用户与 API Token。身份与自动化访问在这里统一审计。",
    section: "access",
    icon: ShieldCheck,
    scopes: ["projects:read", "tokens:manage"],
  },
  credentials: {
    title: "Provider 凭据",
    eyebrow: "PLATFORM / SECRETS",
    subtitle: "绑定模型与镜像 Provider 凭据。长期密钥不进入 Agent 配置、任务快照或工作区。",
    section: "credentials",
    icon: Key,
    scopes: ["agents:read"],
  },
  platform: {
    title: "平台数据与调度",
    eyebrow: "PLATFORM / OPERATIONS",
    subtitle: "维护全局调度纪律与平台配置包。项目数据仍归各自项目空间管理。",
    section: "platform",
    icon: Database,
    scopes: ["agents:read", "exports:read", "imports:read"],
  },
};

export function PlatformSettingsPage() {
  const { me } = useAuth();
  const { section } = useParams<{ section: string }>();
  const config = section ? SECTIONS[section] : undefined;
  if (!config) return <Navigate to="/settings/access" replace />;
  const Icon = config.icon;

  return (
    <div className="flex min-h-full flex-col overflow-x-hidden overflow-y-auto">
      <div className="w-full max-w-[1320px] shrink-0 px-5 pt-7 sm:px-9 sm:pt-9">
        <PageHeader
          title={config.title}
          eyebrow={config.eyebrow}
          subtitle={config.subtitle}
          actions={<span className="grid size-9 place-items-center rounded-md bg-white/[.035] text-zinc-500 ring-1 ring-white/[.06]"><Icon size={17} /></span>}
        />
        <nav aria-label="平台设置分区" className="mt-5 flex gap-1 overflow-x-auto border-b border-white/[.055]">
          {Object.entries(SECTIONS).filter(([, item]) => canAccessAnyScope(me, item.scopes)).map(([key, item]) => (
            <NavLink key={key} to={`/settings/${key}`} className={({ isActive }) => `shrink-0 px-3 py-2 text-[11px] ${isActive ? "border-b border-acc-400 text-zinc-100" : "text-zinc-600 hover:text-zinc-300"}`}>
              {item.title}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="min-h-0 flex-none [&_.settings-content]:flex-none [&_.settings-content]:overflow-visible [&_.settings-panel]:h-auto">
        <SettingsPanel projectId={null} variant="page" globalSection={config.section} />
      </div>
    </div>
  );
}
