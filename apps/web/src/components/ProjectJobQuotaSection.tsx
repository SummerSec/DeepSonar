import { FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, type EffectiveRules, type ProjectSettings } from "../api";
import {
  formatStoredProjectJobQuota,
  nextProjectJobQuotaOnReload,
  parseProjectJobQuotaDraft,
} from "../project-job-quota-draft";
import { HelpTip } from "../ui";

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[14px] text-zinc-200 outline-none transition-colors focus:border-acc-500";
const labelCls = "mb-1.5 block font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500";

/**
 * 项目调度配额独立保存（#644）：草稿与服务端基线分离，其他设置刷新不覆盖未保存输入。
 */
export function ProjectJobQuotaSection({
  projectId,
  settings,
  rules,
  storedQuota,
  onFlash,
  onSettingsSaved,
}: {
  projectId: string;
  settings: ProjectSettings;
  rules: EffectiveRules;
  /** 服务端 rules.maxConcurrentJobs；父级 settings reload 时传入 */
  storedQuota: unknown;
  onFlash: (message: string) => void;
  onSettingsSaved: (saved: ProjectSettings) => void;
}) {
  const [draft, setDraft] = useState("");
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const draftRef = useRef(draft);
  const baselineRef = useRef(baseline);
  draftRef.current = draft;
  baselineRef.current = baseline;

  useEffect(() => {
    draftRef.current = "";
    baselineRef.current = "";
    setDraft("");
    setBaseline("");
    setSaved(false);
    setFailed(false);
  }, [projectId]);

  useEffect(() => {
    const next = nextProjectJobQuotaOnReload(draftRef.current, baselineRef.current, storedQuota);
    setDraft(next.draft);
    setBaseline(next.baseline);
  }, [storedQuota, projectId]);

  const save = async () => {
    let maxConcurrentJobs: number | null;
    try {
      maxConcurrentJobs = parseProjectJobQuotaDraft(draft);
    } catch (e) {
      setFailed(true);
      onFlash(`保存失败：${e instanceof Error ? e.message : e}`);
      return;
    }
    setBusy(true);
    setSaved(false);
    setFailed(false);
    try {
      const result = await api.patchSettings(projectId, { rules: { maxConcurrentJobs } });
      if ("saved" in result && result.saved === false) {
        setFailed(true);
        onFlash("保存失败：运行镜像准备中，请稍后重试");
        return;
      }
      const snapshot = result as ProjectSettings;
      onSettingsSaved(snapshot);
      const nextBaseline = formatStoredProjectJobQuota(
        (snapshot.rules as { maxConcurrentJobs?: unknown } | undefined)?.maxConcurrentJobs,
      );
      setDraft(nextBaseline);
      setBaseline(nextBaseline);
      onFlash("项目调度配额已保存（下一 Job claim 生效）");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setFailed(true);
      onFlash(`保存失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
      <div className="border-b border-white/[.055] px-4 py-3">
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
          <span>项目调度配额</span>
          <HelpTip>
            该项目所有任务共享此额度，不是每个任务分别拥有 M 个名额。
            有效上限 = min(全局每项目上限, 本项设置)；留空则继承全局。
            0 表示暂停领取新 Job，已运行 Job 继续完成。
            计数口径为 claimed / provisioning / running；pending 与 waiting_human 不占额度。
            修改只影响后续 claim，不终止已运行 Job。
          </HelpTip>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>
            最大同时运行 Job 数
            <HelpTip>正整数收紧该项目预算；留空继承全局 {rules.maxJobsPerProject}。</HelpTip>
          </label>
          <input
            type="number"
            min={0}
            max={rules.maxJobsPerProject}
            placeholder={`继承全局 ${rules.maxJobsPerProject}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <div className={labelCls}>当前运行 / 有效上限</div>
          <div className="font-mono text-[15px] text-zinc-200">
            {settings.active_jobs} / {rules.maxConcurrentJobs}
          </div>
          <div className="mt-1 font-mono text-[10px] text-zinc-600">
            来源：{rules.maxConcurrentJobsSource === "project" ? "项目设置" : "继承全局"}
            · 全局硬上限 {rules.maxJobsPerProject}
            · 有效上限 = min(项目设置, 全局硬上限)
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || draft === baseline}
          className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <FloppyDisk size={13} /> {busy ? "保存中…" : saved ? "已保存" : failed ? "保存失败" : "保存项目配额"}
        </button>
        <span className="font-mono text-[10px] text-zinc-600">独立保存；下一 Job claim 生效</span>
      </div>
    </section>
  );
}
