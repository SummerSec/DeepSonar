import { Gear, ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type CanvasSummary, type Project } from "./api";
import { CanvasView } from "./CanvasView";
import { SettingsPanel } from "./SettingsPanel";
import { TaskList, targetLine } from "./TaskList";

const POLL_MS = 5000;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 项目列表：启动时加载一次
  useEffect(() => {
    api
      .projects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length > 0) setCurrentProjectId((c) => c ?? ps[0].id);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // 任务画布列表：5s 轮询；选中粘性（还在列表里就不动，新画布不抢视图）
  useEffect(() => {
    if (!currentProjectId) return;
    setSelectedCanvasId(null);
    let stop = false;
    const tick = () => {
      api
        .canvases(currentProjectId)
        .then((list) => {
          if (stop) return;
          setCanvases(list);
          setSelectedCanvasId((sel) =>
            sel && list.some((c) => c.id === sel) ? sel : (list[0]?.id ?? null),
          );
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [currentProjectId]);

  const selected = canvases.find((c) => c.id === selectedCanvasId) ?? null;

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏：48px，单行 */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-950 px-4">
        <span className="flex items-center gap-2">
          <ShieldCheck size={18} weight="fill" className="text-acc-500" />
          <span className="font-mono text-[13px] font-semibold tracking-tight text-zinc-100">
            DeepFlowHunter
          </span>
        </span>

        <select
          value={currentProjectId ?? ""}
          onChange={(e) => setCurrentProjectId(e.target.value)}
          className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 font-mono text-[12px] text-zinc-200 outline-none transition-colors hover:border-ink-600 focus:border-acc-500"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {/* 当前任务：标题 + 目标 */}
        {selected && (
          <span className="flex min-w-0 items-center gap-2 border-l border-ink-800 pl-3">
            <span className="truncate text-[12px] text-zinc-300">{selected.title}</span>
            {targetLine(selected.target_json) && (
              <span className="truncate font-mono text-[11px] text-zinc-600">
                {targetLine(selected.target_json)}
              </span>
            )}
          </span>
        )}

        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
          <span className="dfh-live-dot inline-block size-1.5 rounded-full bg-acc-500" />
          只读画布 / 5s 轮询
        </span>
        <button
          onClick={() => setShowSettings((s) => !s)}
          aria-label="设置"
          className={`rounded-md p-1.5 transition-colors ${
            showSettings ? "bg-ink-800 text-zinc-100" : "text-zinc-500 hover:bg-ink-800 hover:text-zinc-200"
          }`}
        >
          <Gear size={16} />
        </button>
      </header>

      {error && (
        <div className="flex flex-1 items-center justify-center">
          <div className="rounded-[10px] border border-red-900/60 bg-red-950/40 px-6 py-4 text-sm text-red-300">
            调度器连接失败：{error}（确认 :3100 已启动）
          </div>
        </div>
      )}
      {!error &&
        (currentProjectId ? (
          <div className="flex min-h-0 flex-1">
            <TaskList canvases={canvases} selectedId={selectedCanvasId} onSelect={setSelectedCanvasId} />
            <div className="relative min-w-0 flex-1">
              {selectedCanvasId ? (
                <CanvasView canvasId={selectedCanvasId} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                  暂无任务画布，等待 Plane 领取或 POST /jobs
                </div>
              )}
              {showSettings && (
                <SettingsPanel projectId={currentProjectId} onClose={() => setShowSettings(false)} />
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            暂无项目，先 POST /projects/sync
          </div>
        ))}
    </div>
  );
}
