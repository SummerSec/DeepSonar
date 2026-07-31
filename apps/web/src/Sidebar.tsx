import { useEffect, useState } from "react";
import { api, type CanvasNode, type JobDetail } from "./api";

/** 节点详情侧栏（§10 Phase 4 候选，先做基础版） */
export function Sidebar({ node, onClose }: { node: CanvasNode; onClose: () => void }) {
  const [job, setJob] = useState<JobDetail | null>(null);

  useEffect(() => {
    setJob(null);
    if (node.job_id) {
      api.job(node.job_id).then(setJob).catch(() => {});
    }
  }, [node.id, node.job_id]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <strong>{node.title}</strong>
        <button onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="sidebar-body">
        <dl>
          <dt>类型</dt><dd>{node.node_type}</dd>
          <dt>状态</dt><dd>{node.status ?? "-"}</dd>
          {Object.entries(node.body_json ?? {}).map(([k, v]) => (
            <span key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd><pre>{typeof v === "string" ? v : JSON.stringify(v, null, 2)}</pre></dd>
            </span>
          ))}
        </dl>

        {job && (
          <>
            <h4>事件时间线（{job.events.length}）</h4>
            <ul className="events">
              {job.events.map((e) => (
                <li key={e.id}>
                  <code>#{e.job_seq}</code> <b>{e.type}</b>{" "}
                  <span className="ev-payload">
                    {summarize(e.payload_json)}
                  </span>
                </li>
              ))}
            </ul>
            {job.job.error && <p className="error">错误：{job.job.error}</p>}
          </>
        )}
      </div>
    </aside>
  );
}

function summarize(p: Record<string, unknown>): string {
  const s = (p.message as string) ?? (p.title as string) ?? (p.summary as string) ?? JSON.stringify(p);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}
