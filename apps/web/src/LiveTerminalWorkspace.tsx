import { TerminalWindow, Waveform } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { LiveStream } from "./LiveStream";
import { TerminalPanel } from "./TerminalPanel";

export function LiveTerminalWorkspace({ jobId, terminalAllowed }: { jobId: string; terminalAllowed: boolean }) {
  const [mobileView, setMobileView] = useState<"stream" | "terminal">("stream");
  const [streamPercent, setStreamPercent] = useState(52);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const host = hostRef.current;
    if (!host) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      const percent = ((next.clientX - bounds.left) / bounds.width) * 100;
      setStreamPercent(Math.max(30, Math.min(70, percent)));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  if (desktop) {
    return (
      <div ref={hostRef} className="grid h-full min-h-0" style={{ gridTemplateColumns: `${streamPercent}% 8px minmax(0, 1fr)` }}>
        <div className="min-h-0 overflow-hidden"><LiveStream jobId={jobId} active /></div>
        <button type="button" aria-label="调整实时流与终端宽度" title="调整分栏宽度" onPointerDown={beginResize} className="terminal-resizer"><span /></button>
        <div className="min-h-0 overflow-hidden border-l border-white/[.06]"><TerminalPanel jobId={jobId} active allowed={terminalAllowed} /></div>
      </div>
    );
  }
  return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 gap-1 border-b border-white/[.06] p-2">
          <button type="button" onClick={() => setMobileView("stream")} className={`terminal-segment ${mobileView === "stream" ? "is-active" : ""}`}><Waveform size={14} />实时流</button>
          <button type="button" onClick={() => setMobileView("terminal")} className={`terminal-segment ${mobileView === "terminal" ? "is-active" : ""}`}><TerminalWindow size={14} />终端</button>
        </div>
        <div className={`min-h-0 flex-1 overflow-hidden ${mobileView === "stream" ? "" : "hidden"}`}><LiveStream jobId={jobId} active={mobileView === "stream"} /></div>
        <div className={`min-h-0 flex-1 overflow-hidden ${mobileView === "terminal" ? "" : "hidden"}`}><TerminalPanel jobId={jobId} active={mobileView === "terminal"} allowed={terminalAllowed} /></div>
      </div>
  );
}
