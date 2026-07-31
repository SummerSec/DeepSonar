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
    <div className="app">
      <header className="topbar">
        <span className="logo">DeepFlowHunter</span>
        <select value={current ?? ""} onChange={(e) => setCurrent(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="hint">只读画布 · 5s 轮询</span>
      </header>
      {error && <div className="canvas-error">调度器连接失败：{error}（确认 :3100 已启动）</div>}
      {current ? <CanvasView projectId={current} /> : !error && <div className="canvas-loading">暂无项目，先 POST /projects/sync</div>}
    </div>
  );
}
