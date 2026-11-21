import { FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, type EffectiveRules, type GlobalSettings } from "../api";

const fields = [
  ["maxGlobalJobs", "全局活跃 Job 上限"],
  ["maxJobsPerProject", "每项目活跃 Job 上限"],
  ["maxConcurrentProvisioning", "沙箱启动并发上限"],
] as const;
type QuotaKey = (typeof fields)[number][0];
type Draft = Record<QuotaKey, string>;

function storedDraft(stored: Record<string, unknown>): Draft {
  return Object.fromEntries(fields.map(([key]) => [key, typeof stored[key] === "number" ? String(stored[key]) : ""])) as Draft;
}

export function parseGlobalJobQuotaDraft(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1000) {
    throw new Error("请输入 1–1000 的整数，或留空表示不限。0 不合法，暂停调度请使用平台暂停。");
  }
  return number;
}

/** Stored input and effective caps have separate state so env values never become accidental overrides. */
export function GlobalJobQuotaSection({ storedRules, rules, activeJobs, onSaved, onFlash }: {
  storedRules: Record<string, unknown>;
  rules: EffectiveRules;
  activeJobs: number;
  onSaved: (saved: GlobalSettings) => void;
  onFlash: (message: string, kind: "ok" | "error") => void;
}) {
  const [draft, setDraft] = useState(() => storedDraft(storedRules));
  const [baseline, setBaseline] = useState(() => storedDraft(storedRules));
  const [edited, setEdited] = useState<Partial<Record<QuotaKey, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const current = useRef({ draft, baseline, edited });
  current.current = { draft, baseline, edited };
  useEffect(() => {
    const next = storedDraft(storedRules);
    const previous = current.current;
    setDraft(Object.fromEntries(fields.map(([key]) => [key,
      !previous.edited[key] && previous.draft[key] === previous.baseline[key] ? next[key] : previous.draft[key],
    ])) as Draft);
    setBaseline(next);
  }, [storedRules]);
  const errors = fields.map(([key]) => {
    try { parseGlobalJobQuotaDraft(draft[key]); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  });
  const changed = (key: QuotaKey) => draft[key] !== baseline[key] || Boolean(edited[key]);
  const dirty = fields.some(([key]) => changed(key));
  const save = async () => {
    if (errors.some(Boolean)) return;
    setBusy(true);
    try {
      const patch = Object.fromEntries(fields.filter(([key]) => changed(key)).map(([key]) => [key, parseGlobalJobQuotaDraft(draft[key])]));
      const saved = await api.patchGlobalSettings({ rules: patch });
      const next = storedDraft(saved.rules);
      setDraft(next);
      setBaseline(next);
      setEdited({});
      onSaved(saved);
      onFlash("全局调度配额已保存（后续领取生效）", "ok");
    } catch (error) {
      onFlash(`保存失败：${error instanceof Error ? error.message : error}`, "error");
    } finally { setBusy(false); }
  };
  return (
    <section className="rounded-[18px] bg-white/[.022] p-4 ring-1 ring-white/[.06]">
      <h3 className="mb-2 text-[14px] text-zinc-200">调度器总并发硬上限</h3>
      <p className="mb-3 text-[12px] text-zinc-400">留空并保存表示不限。当前生效值单独显示。修改影响后续领取，运行中的任务继续完成。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([key, label], index) => (
          <div key={key}>
            <label htmlFor={`quota-${key}`} className="mb-1 block text-[12px] text-zinc-400">{label}</label>
            <input id={`quota-${key}`} type="number" min={1} max={1000} step={1} placeholder="不限"
              value={draft[key]} disabled={busy} aria-invalid={Boolean(errors[index])}
              aria-describedby={errors[index] ? `quota-error-${key}` : undefined}
              onChange={event => {
                setEdited(previous => ({ ...previous, [key]: true }));
                setDraft(previous => ({ ...previous, [key]: event.target.value }));
              }}
              className="w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-zinc-200" />
            {errors[index] && <p id={`quota-error-${key}`} role="alert" className="text-[12px] text-red-400">{errors[index]}</p>}
            <p className="mt-1 text-[12px] text-zinc-500">当前生效 {rules[key] ?? "不限"}</p>
            <button type="button" disabled={busy} className="mt-1 text-[12px] text-acc-400"
              onClick={() => {
                setEdited(previous => ({ ...previous, [key]: true }));
                setDraft(previous => ({ ...previous, [key]: "" }));
              }}>恢复{label}不限</button>
          </div>
        ))}
      </div>
      <p className="my-3 text-[12px] text-zinc-500">当前活跃 {activeJobs} / {rules.maxGlobalJobs ?? "不限"}。项目、账号、模型和 Agent CLI 的独立限制继续生效。</p>
      <button type="button" onClick={() => void save()} disabled={busy || !dirty || errors.some(Boolean)}
        className="flex items-center gap-1 rounded-md bg-acc-500 px-3 py-1.5 text-ink-950 disabled:opacity-60">
        <FloppyDisk size={13} />{busy ? "保存中…" : "保存全局调度配额"}
      </button>
    </section>
  );
}
