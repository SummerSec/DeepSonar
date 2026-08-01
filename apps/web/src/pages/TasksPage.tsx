import { ArrowSquareOut, AirplaneTakeoff } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type CanvasSummary, type Project } from "../api";
import { targetLine } from "../TaskList";
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
  formatTime,
  relativeTime,
  tdCls,
  thCls,
  trHover,
} from "../ui";

type Filter = "" | "active" | "findings";

interface PlaneInfo {
  enabled: boolean;
  web_url: string;
  workspace_slug: string;
  ready_state: string;
}

/** Plane 下发指引卡（任务由 Plane issue 驱动：描述写 key=value，移到 Ready 自动认领） */
function PlaneGuide({ project, plane }: { project: Project | undefined; plane: PlaneInfo | null }) {
  const [open, setOpen] = useState(false);
  const projectUrl =
    plane && project
      ? `${plane.web_url}/${plane.workspace_slug}/projects/${project.plane_project_id}/issues/`
      : null;

  return (
    <div className="mb-4 rounded-[10px] border border-ink-700 bg-ink-900/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[14px] text-zinc-300 transition-colors hover:text-zinc-100"
      >
        <AirplaneTakeoff size={16} className="text-acc-400" />
        <span>
          新任务请在 <span className="font-medium text-zinc-100">Plane</span> 下发：创建 issue → 描述写参数 →
          移到「{plane?.ready_state ?? "Ready"}」自动认领
        </span>
        <span className="ml-auto font-mono text-[12px] text-zinc-600">{open ? "收起 ▴" : "展开 ▾"}</span>
      </button>
      {open && (
        <div className="border-t border-ink-800 px-4 py-3 text-[13px] leading-relaxed text-zinc-400">
          <ol className="list-decimal space-y-1.5 pl-4">
            <li>
              在 Plane 项目中新建 issue（标题即任务名）：
              {projectUrl ? (
                <a
                  href={projectUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1.5 inline-flex items-center gap-1 text-acc-400 hover:text-acc-300"
                >
                  打开 Plane 项目 <ArrowSquareOut size={12} />
                </a>
              ) : (
                <span className="ml-1.5 font-mono text-zinc-600">（Plane 未配置，无法生成链接）</span>
              )}
            </li>
            <li>
              描述里按行写键值对（每行一个 <span className="font-mono text-zinc-300">key=value</span>）：
              <pre className="mt-1.5 rounded-md border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-[12px] text-zinc-300">{`type=audit_module
module_path=src/auth
goal=审计认证模块的注入与绕过`}</pre>
              <div className="mt-1 text-zinc-600">
                type 可选：audit_module（审计，默认）/ 任意已启用角色名；其余行（如 module_path、repo_path、goal）会进入任务目标与 prompt
              </div>
            </li>
            <li>
              把 issue 状态移到「<span className="text-zinc-200">{plane?.ready_state ?? "Ready"}</span>
              」—— Plane webhook 事件触发调度器自动认领（事件驱动，无需等待轮询），几分钟后这里出现新任务画布
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [project, setProject] = useState<Project | undefined>(undefined);
  const [plane, setPlane] = useState<PlaneInfo | null>(null);
  const [filter, setFilter] = useState<Filter>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    api.projects().then((list) => setProject(list.find((p) => p.id === projectId))).catch(() => {});
    api.planeInfo().then(setPlane).catch(() => {});
    let stop = false;
    const tick = () => {
      api
        .canvases(projectId)
        .then((list) => {
          if (!stop) {
            setCanvases(list);
            setError(null);
          }
        })
        .catch((e) => {
          if (!stop) setError(String(e));
        });
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [projectId]);

  const filtered = useMemo(() => {
    if (filter === "active") return canvases.filter((c) => c.active_count > 0);
    if (filter === "findings") return canvases.filter((c) => c.finding_count > 0);
    return canvases;
  }, [canvases, filter]);

  if (!projectId) return null;

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title="任务"
        subtitle="项目下的任务列表 · 点「打开画布」进入单任务详情（只看该任务范围与发现）"
        actions={
          <FilterSelect
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            placeholder="全部任务"
            options={[
              { value: "active", label: "仅活跃" },
              { value: "findings", label: "有发现" },
            ]}
          />
        }
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}

      <PlaneGuide project={project} plane={plane} />

      {filtered.length === 0 ? (
        <EmptyState
          title={canvases.length === 0 ? "暂无任务画布" : "没有匹配的任务"}
          hint="在 Plane 创建 issue 并移到「Ready」后，调度器会自动认领并在这里出现任务画布（见上方指引）。"
        />
      ) : (
        <DataTable>
          <table className="w-full min-w-[860px]">
            <thead>
              <tr>
                <th className={thCls}>任务</th>
                <th className={thCls}>目标</th>
                <th className={thCls}>Jobs</th>
                <th className={thCls}>活跃</th>
                <th className={thCls}>发现</th>
                <th className={thCls}>确认</th>
                <th className={thCls}>创建</th>
                <th className={thCls}>画布</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className={trHover}>
                  <td className={tdCls}>
                    <Link
                      to={`/projects/${projectId}/tasks/${c.id}`}
                      className="flex items-center gap-2 font-medium text-zinc-100 hover:text-acc-400"
                    >
                      {c.active_count > 0 && (
                        <span className="dfh-live-dot inline-block size-2 shrink-0 rounded-full bg-run-400" />
                      )}
                      <span className="line-clamp-2">{c.title}</span>
                    </Link>
                  </td>
                  <td className={`${tdCls} max-w-[200px] truncate font-mono text-[13px] text-zinc-500`}>
                    {targetLine(c.target_json) || "—"}
                  </td>
                  <td className={`${tdCls} font-mono tabular-nums`}>{c.job_count}</td>
                  <td
                    className={`${tdCls} font-mono tabular-nums ${c.active_count ? "text-run-400" : "text-zinc-600"}`}
                  >
                    {c.active_count}
                  </td>
                  <td className={`${tdCls} font-mono tabular-nums`}>{c.finding_count}</td>
                  <td
                    className={`${tdCls} font-mono tabular-nums ${c.confirmed_count ? "text-acc-400" : "text-zinc-600"}`}
                  >
                    {c.confirmed_count}
                  </td>
                  <td
                    className={`${tdCls} font-mono text-[13px] text-zinc-500`}
                    title={formatTime(c.created_at)}
                  >
                    {relativeTime(c.created_at)}
                  </td>
                  <td className={tdCls}>
                    <Link
                      to={`/projects/${projectId}/tasks/${c.id}`}
                      className="inline-flex items-center rounded-md border border-acc-500/40 bg-acc-500/10 px-2.5 py-1 font-mono text-[13px] text-acc-400 transition-colors hover:border-acc-500 hover:bg-acc-500/20 hover:text-acc-300"
                    >
                      打开画布 →
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
