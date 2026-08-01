import { useEffect, useState } from "react";
import { NavLink, Outlet, useMatch, useParams } from "react-router-dom";
import { api, type Project } from "../api";

const TABS = [
  { to: "tasks", label: "任务" },
  { to: "findings", label: "发现" },
  { to: "settings", label: "设置" },
];

/** 项目工作区：顶栏项目名 + 子导航；画布详情页隐藏顶栏以省空间 */
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
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-ink-800 px-5">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium text-zinc-100">
              {project?.name ?? "加载中…"}
            </div>
            {project && (
              <div className="truncate font-mono text-[12px] text-zinc-600">
                {project.plane_project_id ? `Plane · ${project.plane_project_id}` : "本地项目"}
                {project.status === "archived" ? " · 已归档" : ""}
              </div>
            )}
          </div>
          <nav className="ml-4 flex items-center gap-1">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={`/projects/${projectId}/${t.to}`}
                className={({ isActive }) =>
                  `rounded-md px-3.5 py-2 text-[14px] transition-colors ${
                    isActive
                      ? "bg-ink-800 text-zinc-100"
                      : "text-zinc-500 hover:bg-ink-850 hover:text-zinc-300"
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
