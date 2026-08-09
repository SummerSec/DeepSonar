import { Check, Copy, Eye, FileCode } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

/**
 * 极简 Markdown 渲染（报告专用）：
 * 不引入第三方依赖、不使用 dangerouslySetInnerHTML —— 按行解析成 React 元素，天然免疫注入。
 * 支持：# ~ #### 标题 / ``` 代码块 / - 与 1. 列表 / > 引用 / --- 分隔线 / 段落；
 * 行内支持 **加粗**、`行内代码`、~~删除线~~、[链接](http/https)。
 */

/** 行内解析：**bold** / `code` / ~~strike~~ / [text](url) */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 依次匹配四种行内语法；顺序即优先级
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(~~([^~]+)~~)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      out.push(
        <strong key={key++} className="font-semibold text-zinc-100">
          {m[2]}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      out.push(
        <code key={key++} className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[13px] text-acc-300">
          {m[4]}
        </code>,
      );
    } else if (m[6] !== undefined) {
      out.push(
        <del key={key++} className="text-zinc-500">
          {m[6]}
        </del>,
      );
    } else if (m[8] !== undefined) {
      out.push(
        <a
          key={key++}
          href={m[9]}
          target="_blank"
          rel="noreferrer"
          className="text-acc-400 underline decoration-acc-500/40 hover:text-acc-300"
        >
          {m[8]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_CLS: Record<number, string> = {
  1: "mt-5 mb-3 text-[20px] font-semibold text-zinc-100 first:mt-0",
  2: "mt-5 mb-2 border-b border-ink-800 pb-1.5 text-[17px] font-semibold text-zinc-100 first:mt-0",
  3: "mt-4 mb-1.5 text-[15px] font-semibold text-zinc-200",
  4: "mt-3 mb-1 text-[14px] font-semibold text-zinc-200",
};

export function MarkdownView({
  markdown,
  controls = true,
  className = "",
  editable = false,
  onChange,
  placeholder,
  rows = 12,
  scrollable = true,
}: {
  markdown: string;
  controls?: boolean;
  className?: string;
  /** 可编辑时：工具栏为「渲染 / 编辑 / 复制」，编辑态为 textarea，与预览合并同一块 */
  editable?: boolean;
  onChange?: (value: string) => void;
  placeholder?: string;
  rows?: number;
  /** Keep vertical scrolling in the caller when this view is inside a larger result pane. */
  scrollable?: boolean;
}) {
  const [mode, setMode] = useState<"rendered" | "source">(editable ? "source" : "rendered");
  const [copied, setCopied] = useState(false);
  const lines = markdown.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码围栏
    if (line.trimStart().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾围栏
      blocks.push(
        <pre
          key={key++}
          className="my-2 overflow-x-auto rounded-lg border border-ink-800 bg-ink-950 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-zinc-300"
        >
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(
        <div key={key++} className={HEADING_CLS[level]}>
          {renderInline(h[2])}
        </div>,
      );
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-3 border-ink-800" />);
      i++;
      continue;
    }

    // 无序列表（连续行聚合）
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-1.5 list-disc space-y-1 pl-5 text-[14px] leading-relaxed text-zinc-300">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="my-1.5 list-decimal space-y-1 pl-5 text-[14px] leading-relaxed text-zinc-300">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="my-2 border-l-2 border-ink-600 pl-3 text-[14px] leading-relaxed text-zinc-400"
        >
          {renderInline(buf.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // 空行
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 普通段落（连续非空行聚合为一段）
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|\s*>\s?|\s*```|\s*(-{3,}|\*{3,})\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-1.5 text-[14px] leading-relaxed text-zinc-300">
        {renderInline(buf.join(" "))}
      </p>,
    );
  }

  const copySource = async () => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(markdown);
    } else {
      const area = document.createElement("textarea");
      area.value = markdown;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const empty = !markdown.trim();
  const showControls = controls || editable;

  return (
    <div className={`markdown-view min-w-0 ${editable ? "markdown-view-editable" : ""} ${className}`}>
      {showControls && (
        <div className="mb-2 flex items-center gap-1 border-b border-white/[.055] pb-2">
          <button
            type="button"
            onClick={() => setMode("rendered")}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 font-mono text-[10px] ${mode === "rendered" ? "bg-white/[.08] text-zinc-200" : "text-zinc-600 hover:text-zinc-300"}`}
          >
            <Eye size={12} /> 渲染
          </button>
          <button
            type="button"
            onClick={() => setMode("source")}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 font-mono text-[10px] ${mode === "source" ? "bg-white/[.08] text-zinc-200" : "text-zinc-600 hover:text-zinc-300"}`}
          >
            <FileCode size={12} /> {editable ? "编辑" : "原文"}
          </button>
          <button
            type="button"
            onClick={() => void copySource().catch(() => setCopied(false))}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 font-mono text-[10px] text-zinc-500 ring-1 ring-white/[.07] hover:text-zinc-200"
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      )}
      {mode === "rendered" ? (
        empty ? (
          <p className="py-6 text-center font-mono text-[11px] text-zinc-600">
            {editable ? "暂无内容，切换到「编辑」开始编写 Markdown。" : "（空）"}
          </p>
        ) : (
          <div className={`markdown-view-body ${scrollable ? "max-h-[65vh] overflow-auto" : "overflow-visible"}`}>{blocks}</div>
        )
      ) : editable ? (
        <textarea
          value={markdown}
          onChange={(event) => onChange?.(event.target.value)}
          rows={rows}
          spellCheck={false}
          placeholder={placeholder}
          className="markdown-view-editor w-full resize-y rounded-xl border border-white/[.08] bg-black/30 px-3 py-2.5 font-mono text-[12px] leading-5 text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-acc-500/50"
        />
      ) : (
        <pre className={`${scrollable ? "max-h-[65vh] overflow-auto" : "overflow-visible"} whitespace-pre-wrap break-words rounded-xl bg-black/30 p-4 font-mono text-[11px] leading-5 text-zinc-400 ring-1 ring-white/[.06]`}>
          {markdown}
        </pre>
      )}
    </div>
  );
}
