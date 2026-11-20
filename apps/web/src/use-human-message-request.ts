import { useEffect, useState } from "react";
import { api, type JobDetail } from "./api";

type RequestDetail = Pick<JobDetail, "human_request" | "human_continuation">;
type RequestRead = { key: string; detail: RequestDetail | null; error: string | null };

/** Canvas summaries are not the authority for a reply's request identity or revision. */
export function useHumanMessageRequest(canvasId: string, jobId: string | null, version?: string) {
  const [read, setRead] = useState<RequestRead | null>(null);
  const [reload, setReload] = useState(0);
  const key = jobId ? JSON.stringify([canvasId, jobId, version, reload]) : null;
  useEffect(() => {
    if (!jobId || !key) return;
    let stopped = false;
    void api.job(jobId).then(detail => {
      if (detail.job.id !== jobId || detail.job.canvas_id !== canvasId) {
        throw new Error("人工请求不属于当前运行或任务，请重新读取。");
      }
      const request = detail.human_request;
      const continuation = detail.human_continuation;
      if (!request || !continuation) throw new Error("当前运行没有持久人工请求，暂不能发送回复。");
      if (detail.job.status !== "waiting_human" || !request.current || continuation.status !== "open"
        || continuation.id !== request.event_id || !Number.isInteger(continuation.revision) || continuation.revision < 0) {
        throw new Error("人工请求已处理或状态已变化，请重新读取并核对当前问题。");
      }
      if (!stopped) setRead({ key, detail, error: null });
    }).catch((cause: unknown) => {
      if (!stopped) setRead({ key, detail: null, error: cause instanceof Error ? cause.message : "人工请求读取失败" });
    });
    return () => { stopped = true; };
  }, [canvasId, jobId, key]);

  const current = read?.key === key ? read : null;
  const continuation = current?.detail?.human_continuation;
  return {
    request: current?.detail?.human_request ?? null,
    target: continuation ? { kind: "request" as const, request_id: continuation.id, expected_revision: continuation.revision } : null,
    status: current?.error ? "error" as const : continuation ? "loaded" as const : "loading" as const,
    error: current?.error ?? undefined,
    retry: () => setReload(value => value + 1),
  };
}
