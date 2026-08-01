import { ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type Project } from "./api";
import { CanvasView } from "./CanvasView";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .projects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length > 0) setCurrent((c) => c ?? ps[0].id);
      })
      .catch((e) => setError(String(e)));
  }, []);

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
          value={current ?? ""}
          onChange={(e) => setCurrent(e.target.value)}
          className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 font-mono text-[12px] text-zinc-200 outline-none transition-colors hover:border-ink-600 focus:border-acc-500"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <span className="ml-auto flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
          <span className="dfh-live-dot inline-block size-1.5 rounded-full bg-acc-500" />
          只读画布 / 5s 轮询
        </span>
      </header>

      {error && (
        <div className="flex flex-1 items-center justify-center">
          <div className="rounded-[10px] border border-red-900/60 bg-red-950/40 px-6 py-4 text-sm text-red-300">
            调度器连接失败：{error}（确认 :3100 已启动）
          </div>
        </div>
      )}
      {!error &&
        (current ? (
          <CanvasView projectId={current} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            暂无项目，先 POST /projects/sync
          </div>
        ))}
    </div>
  );
}
