import {
  Bug,
  ChartBar,
  Crosshair,
  Folder,
  Gear,
  Queue,
  ShieldCheck,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { NavLink, Outlet, useMatch } from "react-router-dom";

const NAV: { to: string; end: boolean; label: string; icon: Icon }[] = [
  { to: "/", end: true, label: "总览", icon: ChartBar },
  { to: "/projects", end: false, label: "项目", icon: Folder },
  { to: "/jobs", end: false, label: "调度队列", icon: Queue },
  { to: "/findings", end: false, label: "发现", icon: Bug },
];

const PROJECT_TABS: { seg: string; label: string; icon: Icon }[] = [
  { seg: "tasks", label: "任务", icon: Crosshair },
  { seg: "findings", label: "发现", icon: Bug },
  { seg: "settings", label: "设置", icon: Gear },
];

function navCls(active: boolean) {
  return `flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[15px] transition-colors ${
    active
      ? "bg-ink-800 text-zinc-100"
      : "text-zinc-500 hover:bg-ink-850 hover:text-zinc-300"
  }`;
}

/** 全局壳：左侧主导航 + 内容区 */
export function AppShell() {
  const projectMatch = useMatch("/projects/:projectId/*");
  const projectId = projectMatch?.params.projectId;

  return (
    <div className="flex h-full">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-ink-800 bg-ink-950">
        <div className="flex h-14 items-center gap-2.5 border-b border-ink-800 px-3.5">
          <ShieldCheck size={20} weight="fill" className="text-acc-500" />
          <span className="font-mono text-[14px] font-semibold tracking-tight text-zinc-100">
            DeepFlowHunter
          </span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 p-2.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => navCls(isActive)}
            >
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}

          {projectId && (
            <div className="mt-4 border-t border-ink-800 pt-3">
              <div className="mb-1.5 px-3 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-600">
                当前项目
              </div>
              {PROJECT_TABS.map((t) => (
                <NavLink
                  key={t.seg}
                  to={`/projects/${projectId}/${t.seg}`}
                  className={({ isActive }) => navCls(isActive)}
                >
                  <t.icon size={17} />
                  {t.label}
                </NavLink>
              ))}
            </div>
          )}
        </nav>

        <div className="border-t border-ink-800 px-3.5 py-3 font-mono text-[12px] text-zinc-600">
          <span className="dfh-live-dot mr-1.5 inline-block size-1.5 rounded-full bg-acc-500" />
          调度器 · 5s 轮询
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-ink-950">
        <Outlet />
      </main>
    </div>
  );
}
