import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Project } from "../api";
import { DataTable, EmptyState, PageHeader, formatTime, tdCls, thCls, trHover } from "../ui";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .projects()
      .then(setProjects)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeader
        title="项目"
        subtitle="先进入项目 → 任务列表 → 打开画布（过程图在任务详情里）"
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}

      {projects.length === 0 && !error ? (
        <EmptyState
          title="暂无项目"
          hint="POST /projects/sync { plane_project_id, name } 或等待 Plane 同步"
        />
      ) : (
        <DataTable>
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className={thCls}>名称</th>
                <th className={thCls}>Plane Project</th>
                <th className={thCls}>创建时间</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className={trHover}>
                  <td className={tdCls}>
                    <Link
                      to={`/projects/${p.id}/tasks`}
                      className="font-medium text-zinc-100 hover:text-acc-400"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                    {p.plane_project_id}
                  </td>
                  <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                    {formatTime(p.created_at)}
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <Link
                      to={`/projects/${p.id}/tasks`}
                      className="inline-flex items-center rounded-md border border-acc-500/40 bg-acc-500/10 px-2.5 py-1 font-mono text-[13px] text-acc-400 transition-colors hover:border-acc-500 hover:bg-acc-500/20"
                    >
                      任务与画布 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
    </div>
  );
}
