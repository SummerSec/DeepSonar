import { useCallback, useEffect, useState, type SetStateAction } from "react";
import { api, type CanvasSummary } from "../api";

type ListStatus = "active" | "archived" | "knowledge_history";
type ListResult = {
  projectId: string;
  status: ListStatus;
  canvases: CanvasSummary[] | null;
  error: string | null;
};
const EMPTY_CANVASES: CanvasSummary[] = [];

export function useTaskCanvasList(projectId: string | undefined, status: ListStatus) {
  const [result, setResult] = useState<ListResult | null>(null);
  const current = result?.projectId === projectId && result?.status === status ? result : null;

  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const canvases = await api.canvases(projectId, { status });
        if (!stop) setResult({ projectId, status, canvases, error: null });
      } catch (error) {
        if (!stop) setResult(previous => ({
          projectId, status, error: String(error),
          canvases: previous?.projectId === projectId && previous.status === status ? previous.canvases : null,
        }));
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => { stop = true; clearInterval(timer); };
  }, [projectId, status]);

  // An action started in another list must not update the current list on completion.
  const setCanvases = useCallback((update: SetStateAction<CanvasSummary[]>) => {
    setResult(previous => {
      if (previous?.projectId !== projectId || previous?.status !== status || !previous.canvases) return previous;
      return { ...previous, canvases: typeof update === "function" ? update(previous.canvases) : update };
    });
  }, [projectId, status]);

  return {
    canvases: current?.canvases ?? EMPTY_CANVASES,
    hasData: current?.canvases != null,
    loading: current === null,
    error: current?.error ?? null,
    setCanvases,
  };
}
