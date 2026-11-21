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
  const confirmationBlocked = verifyStatus !== "confirmed";
  const confirmationHint = "需先通过系统技术验证，才能标记为漏洞存在";
  return <>
    <div className="flex flex-col gap-1.5">
      {DISPOSITION_OPTIONS.map(option => {
        const active = disposition === option.value;
        const blocked = option.value === "confirmed_vuln" && confirmationBlocked;
        return <button
          key={option.value}
          type="button"
          disabled={busy || blocked}
          title={blocked ? confirmationHint : undefined}
          onClick={() => void onChange(option.value as FindingDisposition)}
          className={`rounded-lg px-2.5 py-1.5 text-left text-[12px] ring-1 transition-colors disabled:opacity-50 ${
            active ? "bg-acc-500/15 text-acc-300 ring-acc-400/30" : "theme-surface text-zinc-500 hover:opacity-90"
          }`}
        >
          {option.label}
        </button>;
      })}
    </div>
    {confirmationBlocked && <p className="mt-2 text-[11px] leading-4 text-zinc-500">{confirmationHint}</p>}
    <textarea
      value={note}
      onChange={event => onNoteChange(event.target.value)}
      placeholder="状态备注（切换时一并保存）"
      rows={2}
      className="theme-input-surface mt-2 w-full rounded-lg border px-2.5 py-1.5 text-[12px] outline-none focus:border-acc-500"
    />
  </>;
}
