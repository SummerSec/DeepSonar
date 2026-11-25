import type { FindingDisposition } from "./api";
import { DISPOSITION_OPTIONS } from "./ui";

export function FindingDispositionEditor({ disposition, verifyStatus, busy, note, onNoteChange, onChange }: {
  disposition: string;
  verifyStatus: string;
  busy: boolean;
  note: string;
  onNoteChange: (note: string) => void;
  onChange: (disposition: FindingDisposition) => Promise<void>;
}) {
  // #1264：人工确认漏洞存在不再以系统技术验证为前提；两者是分开记录的事实。
  const confirmationHint = "人工确认与平台技术验证分开记录，确认后仍按 Verify 自己的结论展示";
  return <>
    <div className="flex flex-col gap-1.5">
      {DISPOSITION_OPTIONS.map(option => {
        const active = disposition === option.value;
        return <button
          key={option.value}
          type="button"
          disabled={busy}
          title={option.value === "confirmed_vuln" ? confirmationHint : undefined}
          onClick={() => void onChange(option.value as FindingDisposition)}
          className={`rounded-lg px-2.5 py-1.5 text-left text-[12px] ring-1 transition-colors disabled:opacity-50 ${
            active ? "bg-acc-500/15 text-acc-300 ring-acc-400/30" : "theme-surface text-zinc-500 hover:opacity-90"
          }`}
        >
          {option.label}
        </button>;
      })}
    </div>
    {verifyStatus !== "confirmed" && <p className="mt-2 text-[11px] leading-4 text-zinc-500">{confirmationHint}</p>}
    <textarea
      value={note}
      onChange={event => onNoteChange(event.target.value)}
      placeholder="状态备注（切换时一并保存）"
      rows={2}
      className="theme-input-surface mt-2 w-full rounded-lg border px-2.5 py-1.5 text-[12px] outline-none focus:border-acc-500"
    />
  </>;
}
