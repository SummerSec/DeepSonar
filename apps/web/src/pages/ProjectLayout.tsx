import { CaretRight } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useMatch, useParams } from "react-router-dom";
import { api, type Project } from "../api";

const TABS = [
  { to: "tasks", label: "任务" },
  { to: "findings", label: "发现" },
  { to: "settings", label: "设置" },
];

/** 项目工作区：提供轻量上下文与项目级分区；任务工作台保留最大画布空间。 */
export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const onCanvas = Boolean(useMatch("/projects/:projectId/tasks/:canvasId"));
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api
      .projects()
      .then((ps) => setProject(ps.find((p) => p.id === projectId) ?? null))
      .catch(() => setProject(null));
  }, [projectId]);

  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!onCanvas && (
        <header className="mx-3 mt-3 flex min-h-14 shrink-0 items-center gap-3 rounded-[20px] bg-white/[.025] px-4 py-2 ring-1 ring-white/[.055]">
          <div className="min-w-0 flex items-center gap-2">
            <span className="hidden font-mono text-[9px] tracking-[.16em] text-zinc-700 sm:inline">PROJECT</span>
            <CaretRight size={11} className="hidden text-zinc-700 sm:block" />
            <div className="truncate text-[12px] font-medium text-zinc-200">
              {project?.name ?? "加载中…"}
            </div>
          </div>
          {project && <span className="hidden rounded-full bg-white/[.03] px-2 py-1 font-mono text-[8px] text-zinc-600 md:inline">{project.plane_project_id ? "PLANE CONNECTED" : "LOCAL"}{project.status === "archived" ? " · ARCHIVED" : ""}</span>}
          <nav className="ml-auto flex items-center gap-1 rounded-full bg-black/20 p-1">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={`/projects/${projectId}/${t.to}`}
                className={({ isActive }) =>
                  `rounded-full px-3 py-1.5 text-[11px] transition-colors ${
                    isActive
                      ? "bg-white/[.08] text-zinc-100"
                      : "text-zinc-600 hover:bg-white/[.04] hover:text-zinc-300"
                  }`
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet context={{ projectId, project }} />
      </div>
    </div>
  );
}
