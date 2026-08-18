import { ArrowsClockwise, Broom, ClipboardText, Copy, PlugsConnected, Plugs } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type TerminalState = "idle" | "connecting" | "connected" | "closed" | "error";

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document.execCommand !== "function" || !document.body) {
    throw new Error("CLIPBOARD_UNAVAILABLE");
  }

  const textarea = document.createElement("textarea");
  const activeElement = document.activeElement as HTMLElement | null;
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("CLIPBOARD_DENIED");
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
}

function getTerminalBufferText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n").replace(/\n+$/, "");
}

export function TerminalPanel({ jobId, active, allowed }: { jobId: string; active: boolean; allowed: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<TerminalState>("idle");
  const [status, setStatus] = useState("终端尚未连接");
  const [copyFeedback, setCopyFeedback] = useState("");

  const copyText = async (text: string, label: string) => {
    if (text.length === 0) {
      setCopyFeedback(`没有可复制的${label}`);
      return;
    }
    try {
      await writeClipboard(text);
      setCopyFeedback(`已复制${label}`);
    } catch (error) {
      const denied = (error instanceof DOMException && error.name === "NotAllowedError") || (error instanceof Error && error.message === "CLIPBOARD_DENIED");
      setCopyFeedback(denied ? "复制失败：浏览器未授予剪贴板权限" : "复制失败：当前浏览器不支持剪贴板");
    }
  };

  useEffect(() => {
    if (!copyFeedback) return;
    const timeout = window.setTimeout(() => setCopyFeedback(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  useEffect(() => {
    if (!active || !allowed || !hostRef.current) return;
    let disposed = false;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Noto Sans Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 3000,
      theme: {
        background: "#080a0b",
        foreground: "#d4d4d8",
        cursor: "#34d399",
        selectionBackground: "#334155aa",
        black: "#18181b",
        red: "#f87171",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const fitAndResize = () => {
      if (disposed) return;
      try { fit.fit(); } catch { return; }
      const ws = socketRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(hostRef.current);
    const sendInput = (data: string) => {
      const ws = socketRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    };
    const input = terminal.onData(sendInput);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        if (event.type === "keydown") terminal.input(event.shiftKey ? "\u001b[Z" : "\t");
        return false;
      }

      const copyShortcut = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c";
      if (copyShortcut && terminal.hasSelection()) {
        event.preventDefault();
        if (event.type === "keydown") void copyText(terminal.getSelection(), "选中内容");
        return false;
      }
      return true;
    });

    const connect = async () => {
      setState("connecting");
      setStatus("正在连接 Job 沙箱…");
      try {
        fitAndResize();
        const ticket = await api.createWsTicket(jobId, "terminal");
        if (disposed) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const query = new URLSearchParams({
          job_id: jobId,
          ticket: ticket.ticket,
          cols: String(terminal.cols || 120),
          rows: String(terminal.rows || 32),
        });
        const socket = new WebSocket(`${proto}://${location.host}/api/terminal-ws?${query.toString()}`);
        socketRef.current = socket;
        socket.onopen = () => {
          if (disposed) return;
          setState("connected");
          setStatus("已连接");
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: string; data?: string };
            if (message.type === "output" && typeof message.data === "string") terminal.write(message.data);
          } catch {
            terminal.write("\r\n[terminal protocol error]\r\n");
          }
        };
        socket.onclose = (event) => {
          if (disposed) return;
          setState(event.code === 1000 ? "closed" : "error");
          const labels: Record<number, string> = {
            4401: "终端凭证无效或已过期",
            4403: "当前账号无终端权限",
            4409: "Job 已结束",
            4411: "Job 沙箱已回收",
            4412: "当前运行环境不支持 PTY",
            4413: "终端因空闲超时关闭",
            4414: "终端达到流量或帧限制",
          };
          setStatus(labels[event.code] ?? (event.code === 1000 ? "终端已关闭" : "终端连接中断"));
        };
        socket.onerror = () => {
          if (!disposed) {
            setState("error");
            setStatus("终端连接错误");
          }
        };
      } catch (error) {
        if (disposed) return;
        setState("error");
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message.includes("403") || message.includes("PERMISSION") ? "当前账号无终端权限" : "终端暂不可用");
      }
    };
    void connect();
    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "close" }));
      socket?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [active, allowed, generation, jobId]);

  if (!allowed) {
    return <div className="grid h-full place-items-center px-6 text-center font-mono text-[11px] text-zinc-600">当前账号没有 Job 终端权限</div>;
  }

  return (
    <div className="theme-drawer flex h-full min-h-0 flex-col">
      <div className="theme-drawer-header flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className={`size-1.5 rounded-full ${state === "connected" ? "bg-emerald-400" : state === "error" ? "bg-red-400" : "bg-zinc-600"}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-500">{status}</span>
        <span role="status" aria-live="polite" aria-atomic="true" className={copyFeedback ? "font-mono text-[10px] text-zinc-400" : "sr-only"}>{copyFeedback}</span>
        <button type="button" title="复制选中内容" aria-label="复制选中内容" onClick={() => { const terminal = terminalRef.current; void copyText(terminal?.hasSelection() ? terminal.getSelection() : "", "选中内容"); }} className="terminal-tool-button"><Copy size={14} /></button>
        <button type="button" title="复制终端缓冲" aria-label="复制全部终端内容" onClick={() => { const terminal = terminalRef.current; void copyText(terminal ? getTerminalBufferText(terminal) : "", "终端缓冲"); }} className="terminal-tool-button"><ClipboardText size={14} /></button>
        <button type="button" title="清屏" aria-label="清屏" onClick={() => terminalRef.current?.clear()} className="terminal-tool-button"><Broom size={14} /></button>
        <button type="button" title="重新连接" aria-label="重新连接" onClick={() => setGeneration((value) => value + 1)} className="terminal-tool-button"><ArrowsClockwise size={14} /></button>
        <button type="button" title={state === "connected" ? "断开" : "连接"} aria-label={state === "connected" ? "断开" : "连接"} onClick={() => state === "connected" ? socketRef.current?.close(1000, "manual") : setGeneration((value) => value + 1)} className="terminal-tool-button">{state === "connected" ? <Plugs size={14} /> : <PlugsConnected size={14} />}</button>
      </div>
      <div ref={hostRef} className="terminal-host min-h-0 flex-1 bg-[#080a0b] p-2" />
    </div>
  );
}
