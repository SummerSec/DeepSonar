import { ArrowRight, CircleNotch, Sparkle } from "@phosphor-icons/react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { TaskCanvasPage } from "./TaskCanvasPage";

/**
 * The launch rail hands the user to the existing canvas. The overlay is kept in
 * a route wrapper so TaskCanvasPage remains focused on canvas data and PR-owned
 * task interactions do not need to know about the quick-start flow.
 */
export function TaskCanvasRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const handoff = searchParams.get("handoff") === "1";

  useEffect(() => {
    if (!handoff) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      next.delete("handoff");
      setSearchParams(next, { replace: true });
    }, 5200);
    return () => window.clearTimeout(timer);
  }, [handoff, searchParams, setSearchParams]);

  return (
    <>
      <TaskCanvasPage />
      {handoff && (
        <div className="task-handoff-overlay" role="status" aria-live="polite">
          <div className="task-handoff-mark" aria-hidden="true"><Sparkle size={18} weight="light" /></div>
          <div className="task-handoff-copy">
            <span className="eyebrow"><span style={{ background: "var(--accent)" }} />TASK HANDOFF</span>
            <strong>目标已进入画布</strong>
            <p>平台正在决定第一步。Hub 会读取任务意图并选择下一步，你可以先查看目标范围。</p>
          </div>
          <div className="task-handoff-progress" aria-hidden="true"><span /><span className="is-active"><CircleNotch size={11} /></span><span /></div>
          <span className="task-handoff-arrow" aria-hidden="true"><ArrowRight size={15} weight="light" /></span>
        </div>
      )}
    </>
  );
}
