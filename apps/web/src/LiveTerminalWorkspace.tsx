import { TerminalWindow, Waveform, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { LiveStream } from "./LiveStream";
import { TerminalPanel } from "./TerminalPanel";

export function LiveTerminalWorkspace({ jobId, terminalAllowed }: { jobId: string; terminalAllowed: boolean }) {
  const [mobileView, setMobileView] = useState<"stream" | "terminal">("stream");
  const [desktopTerminalOpen, setDesktopTerminalOpen] = useState(false);
  const [terminalJobId, setTerminalJobId] = useState(jobId);
  const [streamPercent, setStreamPercent] = useState(52);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setDesktopTerminalOpen(false);
    setMobileView("stream");
    setTerminalJobId(jobId);
  }, [jobId]);

  useEffect(() => {
    if (!terminalAllowed) {
      setDesktopTerminalOpen(false);
      setMobileView("stream");
    }
  }, [terminalAllowed]);

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

  if (desktop && terminalAllowed && desktopTerminalOpen && terminalJobId === jobId) {
    return (
      <div ref={hostRef} className="grid h-full min-h-0" style={{ gridTemplateColumns: `${streamPercent}% 8px minmax(0, 1fr)` }}>
        <div className="min-h-0 overflow-hidden"><LiveStream jobId={jobId} active /></div>
        <button
          type="button"
          aria-label="调整实时流与终端宽度"
          title="调整分栏宽度"
          onPointerDown={beginResize}
          className="terminal-resizer"
        >
          <span />
        </button>
        <div className="flex min-h-0 flex-col overflow-hidden border-l border-white/[.06]">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[.06] px-3">
            <TerminalWindow size={14} className="text-zinc-500" />
            <span className="flex-1 font-mono text-[10px] text-zinc-500">终端</span>
            <button
              type="button"
              aria-label="关闭终端"
              title="关闭终端"
              onClick={() => setDesktopTerminalOpen(false)}
              className="terminal-tool-button focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-acc-400"
            >
              <X size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden"><TerminalPanel key={jobId} jobId={jobId} active allowed /></div>
        </div>
      </div>
    );
  }

  if (desktop) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {terminalAllowed && (
          <div className="flex shrink-0 justify-end border-b border-white/[.06] px-3 py-1">
            <button
              type="button"
              aria-label="打开终端"
              title="打开终端"
              onClick={() => setDesktopTerminalOpen(true)}
              className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 font-mono text-[10px] text-zinc-500 ring-1 ring-white/[.08] transition-colors hover:bg-white/[.05] hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-acc-400"
            >
              <TerminalWindow size={13} />
              终端
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden"><LiveStream jobId={jobId} active /></div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-white/[.06] p-2">
        <button
          type="button"
          onClick={() => setMobileView("stream")}
          className={`terminal-segment focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-acc-400 ${mobileView === "stream" ? "is-active" : ""}`}
        >
          <Waveform size={14} />
          实时流
        </button>
        {terminalAllowed && (
          <button
            type="button"
            onClick={() => setMobileView("terminal")}
            className={`terminal-segment focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-acc-400 ${mobileView === "terminal" ? "is-active" : ""}`}
          >
            <TerminalWindow size={14} />
            终端
          </button>
        )}
      </div>
      {mobileView === "terminal" && terminalAllowed && terminalJobId === jobId ? (
        <div className="min-h-0 flex-1 overflow-hidden"><TerminalPanel key={jobId} jobId={jobId} active allowed /></div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden"><LiveStream jobId={jobId} active /></div>
      )}
    </div>
  );
}
