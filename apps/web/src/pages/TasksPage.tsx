import { AirplaneTakeoff, ArrowSquareOut, Plus } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type AgentProfile, type CanvasSummary, type Project, type ProjectRole, type ProjectSettings } from "../api";
import { targetLine } from "../TaskList";
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
  StatusBadge,
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

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[14px] text-zinc-200 outline-none transition-colors focus:border-acc-500";
const labelCls = "mb-1 block font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500";

const ACTIVE_STATUS = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);
const RESUMABLE_STATUS = new Set(["waiting_human", "orphan", "failed", "timeout"]);
const TERMINAL_STATUS = new Set(["succeeded", "failed", "timeout", "cancelled", "orphan"]);

/** Plane 下发指引卡（仅已绑定 Plane 的项目显示；本地项目用「新建任务」直接下发） */
function PlaneGuide({ project, plane }: { project: Project; plane: PlaneInfo | null }) {
  const [open, setOpen] = useState(false);
  const projectUrl = plane
    ? `${plane.web_url}/${plane.workspace_slug}/projects/${project.plane_project_id}/issues/`
    : null;

  return (
    <div className="mb-4 rounded-[10px] border border-ink-700 bg-ink-900/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[14px] text-zinc-300 transition-colors hover:text-zinc-100"
      >
        <AirplaneTakeoff size={16} className="text-run-400" />
        <span>
          本项目已绑定 Plane：也可以从 Plane 下发（issue 移到「{plane?.ready_state ?? "Ready"}」自动认领）
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
            </li>
            <li>
              把 issue 状态移到「<span className="text-zinc-200">{plane?.ready_state ?? "Ready"}</span>
              」—— Plane webhook 事件触发调度器自动认领；本地「新建任务」与 Plane 下发的画布完全同构
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}

/** 新建任务表单（§LOCAL_PROJECT_MANAGEMENT §8.2：标题/类型/目标/优先级/超时 + 生效 profile 摘要） */
function NewTaskForm({
  projectId,
  roles,
  settings,
  profiles,
  onDone,
  flash,
}: {
  projectId: string;
  roles: ProjectRole[];
  settings: ProjectSettings | null;
  profiles: AgentProfile[];
  onDone: () => void;
  flash: (m: string) => void;
}) {
  const [form, setForm] = useState({
    title: "",
    type: "audit_module",
    module_path: "",
    repo_path: "",
    goal: "",
    priority: 0,
    timeout_sec: 3600,
  });
  const typeOptions = ["audit_module", ...roles.filter((r) => r.enabled).map((r) => r.name)];
  // 生效 profile 摘要：类型绑定 → default 绑定 → env 全局
  const boundId = settings?.profiles?.[form.type] ?? settings?.profiles?.default;
  const boundProfile = profiles.find((p) => p.id === boundId);

  return (
    <div className="mb-4 flex flex-col gap-2.5 rounded-[10px] border border-ink-700 bg-ink-900/60 p-4">
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
        新建任务（创建即入队，调度器自动执行）
      </div>
      <div>
        <label className={labelCls}>任务标题</label>
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          className={inputCls}
          placeholder="如 审计 auth 模块"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>任务类型</label>
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
            className={inputCls}
          >
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>生效 agent 配置</label>
          <div className="rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 font-mono text-[13px] text-zinc-400">
            {boundProfile ? `${boundProfile.name}（${boundProfile.agent_cli}）` : "env 全局配置（未绑定 profile）"}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>模块范围（module_path）</label>
          <input
            value={form.module_path}
            onChange={(e) => setForm({ ...form, module_path: e.target.value })}
            className={inputCls}
            placeholder="如 src/auth（空=全部）"
          />
        </div>
        <div>
          <label className={labelCls}>仓库路径（repo_path，可选）</label>
          <input
            value={form.repo_path}
            onChange={(e) => setForm({ ...form, repo_path: e.target.value })}
            className={inputCls}
            placeholder="如 D:/repo/target"
          />
        </div>
      </div>
      <div>
        <label className={labelCls}>目标描述（goal，进入 prompt 与画布目标）</label>
        <input
          value={form.goal}
          onChange={(e) => setForm({ ...form, goal: e.target.value })}
          className={inputCls}
          placeholder="如 审计认证模块的注入与绕过（空=用标题）"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>优先级（越大越先跑）</label>
          <input
            type="number"
            value={String(form.priority)}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>超时（秒）</label>
          <input
            type="number"
            value={String(form.timeout_sec)}
            onChange={(e) => setForm({ ...form, timeout_sec: Number(e.target.value) })}
            className={inputCls}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={async () => {
            if (!form.title.trim()) return flash("任务标题必填");
            try {
              const payload: Record<string, unknown> = {};
              if (form.module_path.trim()) payload.module_path = form.module_path.trim();
              if (form.repo_path.trim()) payload.repo_path = form.repo_path.trim();
              if (form.goal.trim()) payload.goal = form.goal.trim();
              await api.createTask(projectId, {
                title: form.title.trim(),
                type: form.type,
                priority: form.priority,
                timeout_sec: form.timeout_sec,
                payload,
              });
              flash("任务已创建并入队");
              onDone();
            } catch (e) {
              flash(`创建失败：${e instanceof Error ? e.message : e}`);
            }
          }}
          className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
        >
          <Plus size={13} /> 创建任务
        </button>
        <button
          onClick={onDone}
          className="rounded-md border border-ink-700 px-3 py-1.5 text-[14px] text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200"
        >
          取消
        </button>
      </div>
    </div>
  );
}

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [project, setProject] = useState<Project | undefined>(undefined);
  const [plane, setPlane] = useState<PlaneInfo | null>(null);
  const [roles, setRoles] = useState<ProjectRole[]>([]);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [filter, setFilter] = useState<Filter>("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  useEffect(() => {
    if (!projectId) return;
    api.projects().then((list) => setProject(list.find((p) => p.id === projectId))).catch(() => {});
    api.planeInfo().then(setPlane).catch(() => {});
    api.projectRoles(projectId).then(setRoles).catch(() => {});
    api.settings(projectId).then(setSettings).catch(() => {});
    api.agentProfiles().then(setProfiles).catch(() => {});
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
        subtitle="创建任务即入队执行 · 点「打开画布」进入单任务详情（只看该任务范围与发现）"
        actions={
          <div className="flex items-center gap-2">
            <FilterSelect
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              placeholder="全部任务"
              options={[
                { value: "active", label: "仅活跃" },
                { value: "findings", label: "有发现" },
              ]}
            />
            {project?.status === "active" && (
              <button
                onClick={() => setCreating((c) => !c)}
                className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
              >
                <Plus size={14} /> 新建任务
              </button>
            )}
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}
      {msg && (
        <div className="mb-4 rounded-[10px] border border-acc-500/40 bg-acc-500/10 px-4 py-2.5 font-mono text-[13px] text-acc-400">
          {msg}
        </div>
      )}

      {creating && (
        <NewTaskForm
          projectId={projectId}
          roles={roles}
          settings={settings}
          profiles={profiles}
          flash={flash}
          onDone={() => setCreating(false)}
        />
      )}

      {project?.plane_project_id && <PlaneGuide project={project} plane={plane} />}

      {filtered.length === 0 ? (
        <EmptyState
          title={canvases.length === 0 ? "暂无任务" : "没有匹配的任务"}
          hint={
            canvases.length === 0
              ? "点右上角「新建任务」，创建后调度器会自动开始执行。"
              : "调整筛选条件查看其它任务。"
          }
        />
      ) : (
        <DataTable>
          <table className="w-full min-w-[960px]">
            <thead>
              <tr>
                <th className={thCls}>任务</th>
                <th className={thCls}>状态</th>
                <th className={thCls}>目标</th>
                <th className={thCls}>优先级</th>
                <th className={thCls}>尝试</th>
                <th className={thCls}>发现</th>
                <th className={thCls}>确认</th>
                <th className={thCls}>创建</th>
                <th className={thCls}>操作</th>
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
                  <td className={tdCls}>
                    {c.last_job_status ? <StatusBadge status={c.last_job_status} /> : "—"}
                  </td>
                  <td className={`${tdCls} max-w-[180px] truncate font-mono text-[13px] text-zinc-500`}>
                    {targetLine(c.target_json) || "—"}
                  </td>
                  <td className={`${tdCls} font-mono tabular-nums text-zinc-400`}>
                    {c.last_job_priority ?? "—"}
                  </td>
                  <td className={`${tdCls} font-mono tabular-nums`}>{c.job_count}</td>
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
                    <div className="flex items-center gap-1.5">
                      {c.last_job_id && c.last_job_status && ACTIVE_STATUS.has(c.last_job_status) && (
                        <button
                          onClick={async () => {
                            await api.cancelJob(c.last_job_id!).catch((e) => flash(`取消失败：${e instanceof Error ? e.message : e}`));
                            flash("已取消");
                          }}
                          className="rounded-md border border-red-900/60 px-2 py-1 font-mono text-[12px] text-red-300 transition-colors hover:bg-red-950/40"
                        >
                          取消
                        </button>
                      )}
                      {c.last_job_id && c.last_job_status && RESUMABLE_STATUS.has(c.last_job_status) && (
                        <button
                          onClick={async () => {
                            await api.resumeJob(c.last_job_id!).catch((e) => flash(`恢复失败：${e instanceof Error ? e.message : e}`));
                            flash("已恢复入队");
                          }}
                          className="rounded-md border border-ink-700 px-2 py-1 font-mono text-[12px] text-zinc-300 transition-colors hover:border-ink-600"
                          title="恢复原执行（waiting_human/orphan/failed/timeout → pending）"
                        >
                          恢复
                        </button>
                      )}
                      {c.last_job_status && TERMINAL_STATUS.has(c.last_job_status) && (
                        <button
                          onClick={async () => {
                            try {
                              await api.retryTask(c.id);
                              flash("已重试：新 job 复用原画布，历史保留");
                            } catch (e) {
                              flash(`重试失败：${e instanceof Error ? e.message : e}`);
                            }
                          }}
                          className="rounded-md border border-ink-700 px-2 py-1 font-mono text-[12px] text-zinc-300 transition-colors hover:border-acc-500/60 hover:text-acc-300"
                          title="新建 job 重跑该任务（不改历史）"
                        >
                          重试
                        </button>
                      )}
                      <Link
                        to={`/projects/${projectId}/tasks/${c.id}`}
                        className="inline-flex items-center rounded-md border border-acc-500/40 bg-acc-500/10 px-2.5 py-1 font-mono text-[13px] text-acc-400 transition-colors hover:border-acc-500 hover:bg-acc-500/20 hover:text-acc-300"
                      >
                        画布 →
                      </Link>
                    </div>
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
