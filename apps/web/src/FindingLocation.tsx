import { Copy } from "@phosphor-icons/react";
import { writeClipboard } from "./clipboard";
import { useFlashMessage } from "./use-flash-message";

export function FindingLocation({ location }: { location: string }) {
  const { message, flash } = useFlashMessage();
  async function copyLocation() {
    try {
      await writeClipboard(location);
      flash("已复制");
    } catch {
      flash("复制失败，请手动选中并复制");
    }
  }

  return (
    <div className="theme-input-surface mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 font-mono text-[11px] text-zinc-400">
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-all">
        <span className="text-zinc-600">location </span>{location}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <button type="button" aria-label="复制代码位置" title="复制代码位置" onClick={copyLocation}
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-500 ring-1 ring-white/[.07] hover:text-zinc-200">
          <Copy size={12} /> 复制
        </button>
        <span role="status" className="max-w-24 text-right empty:sr-only">{message}</span>
      </div>
    </div>
  );
}
