import { FloppyDisk } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type ProviderCredential } from "../api";
import { SearchableSelect } from "../SearchableSelect";
import { HelpTip } from "../ui";
import { showToast } from "../toast";

function catalogModels(credential: ProviderCredential): string[] {
  const raw = credential.model_catalog_json;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const model = item.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

export function ProjectModelPolicyPanel({
  projectId,
  credentials,
  enabledCredentialIds,
  enabledModelIds,
  defaultModelId,
  fallbackModelIds,
  modelPolicyConfigured,
  onSaved,
}: {
  projectId: string;
  credentials: ProviderCredential[];
  enabledCredentialIds: string[];
  enabledModelIds: string[];
  defaultModelId: string | null;
  fallbackModelIds: string[];
  modelPolicyConfigured?: boolean;
  onSaved: () => void;
}) {
  const [models, setModels] = useState<string[]>(enabledModelIds);
  const [defaultModel, setDefaultModel] = useState<string>(defaultModelId ?? "");
  const [fallbacks, setFallbacks] = useState<string[]>(fallbackModelIds);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setModels(enabledModelIds);
    setDefaultModel(defaultModelId ?? "");
    setFallbacks(fallbackModelIds);
  }, [enabledModelIds, defaultModelId, fallbackModelIds]);

  const candidateModels = useMemo(() => {
    const enabledCreds = new Set(enabledCredentialIds);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const credential of credentials) {
      if (credential.kind !== "llm_provider") continue;
      if (credential.project_id != null && credential.project_id !== projectId) continue;
      if (enabledCreds.size > 0 && !enabledCreds.has(credential.id)) continue;
      for (const model of catalogModels(credential)) {
        if (seen.has(model)) continue;
        seen.add(model);
        out.push(model);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [credentials, enabledCredentialIds, projectId]);

  const toggleModel = (model: string) => {
    setModels((current) => {
      if (current.includes(model)) {
        const next = current.filter((item) => item !== model);
        if (defaultModel === model) setDefaultModel("");
        setFallbacks((fb) => fb.filter((item) => item !== model));
        return next;
      }
      return [...current, model];
    });
  };

  const toggleFallback = (model: string) => {
    setFallbacks((current) => {
      if (current.includes(model)) return current.filter((item) => item !== model);
      return [...current, model];
    });
  };

  const save = async () => {
    if (models.length === 0) {
      showToast("至少启用一个模型", "error");
      return;
    }
    if (defaultModel && !models.includes(defaultModel)) {
      showToast("缺省模型必须属于已启用白名单", "error");
      return;
    }
    if (fallbacks.some((id) => !models.includes(id))) {
      showToast("fallback 模型必须属于已启用白名单", "error");
      return;
    }
    setBusy(true);
    setSaved(false);
    setFailed(false);
    try {
      await api.patchSettings(projectId, {
        enabled_model_ids: models,
        default_model_id: defaultModel || null,
        fallback_model_ids: fallbacks,
      });
      showToast("模型允许/缺省/fallback 已保存（下一 job 生效；已配置后 fail-closed）", "ok");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (error) {
      setFailed(true);
      showToast(`保存失败：${error instanceof Error ? error.message : error}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-[18px] bg-white/[.022] ring-1 ring-white/[.06]">
      <div className="border-b border-white/[.055] px-4 py-3">
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">
          <span>模型允许 / 缺省 / Fallback</span>
          <HelpTip>
            平台只划定项目级模型边界；Hub 通过 list_available_models 从已启用凭据目录 ∩ 本白名单选型。
            未首次保存前不按项目策略 fail-closed（仍走 RoleConfig / 凭据目录校验）。保存后目录外拒绝。界面不暴露密钥。
            缺省与 fallback 是软回退（Hub/角色省略 model 时使用），不是按角色锁死身份。
          </HelpTip>
        </div>
        <div className="mt-1 text-[11px] text-zinc-500">
          {modelPolicyConfigured ? "策略已配置（fail-closed）" : "尚未配置（兼容旧行为）"}
        </div>
      </div>
      <div className="space-y-4 px-4 py-4">
        <div>
          <div className="mb-2 text-[12px] text-zinc-400">启用模型（来自已启用 Provider 的模型目录）</div>
          {candidateModels.length === 0 ? (
            <div className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-[12px] text-zinc-500">
              暂无候选模型。请先在「CLI / Provider 启用」勾选账号，并在「凭据」页测试凭据以发现模型目录。
            </div>
          ) : (
            <div className="flex max-h-56 flex-wrap gap-2 overflow-y-auto">
              {candidateModels.map((model) => {
                const on = models.includes(model);
                return (
                  <label
                    key={model}
                    className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${
                      on ? "border-acc-400/50 bg-acc-400/[.06] text-zinc-100" : "border-ink-700 text-zinc-400"
                    }`}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggleModel(model)} className="accent-emerald-500" />
                    <span className="font-mono">{model}</span>
                  </label>
                );
              })}
            </div>
          )}
          {models.length === 0 && (
            <div className="mt-2 text-[12px] text-amber-400/90">未启用任何模型时无法保存策略；保存后将按白名单 fail-closed。</div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] text-zinc-400">缺省模型（软回退）</div>
            <SearchableSelect
              value={defaultModel}
              onChange={(next) => setDefaultModel(next || "")}
              options={[
                { value: "", label: "不设缺省（回退 RoleConfig / CLI）" },
                ...models.map((model) => ({ value: model, label: model })),
              ]}
              placeholder="选择缺省模型"
              ariaLabel="缺省模型"
              className="searchable-select-wrap"
            />
          </div>
          <div>
            <div className="mb-1 text-[12px] text-zinc-400">Fallback 模型（有序，可多选）</div>
            {models.length === 0 ? (
              <div className="text-[12px] text-zinc-500">先启用模型后再选 fallback。</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {models.map((model) => {
                  const on = fallbacks.includes(model);
                  return (
                    <label
                      key={model}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                        on ? "border-acc-400/40 bg-acc-400/[.05]" : "border-ink-700"
                      }`}
                    >
                      <input type="checkbox" checked={on} onChange={() => toggleFallback(model)} className="accent-emerald-500" />
                      <span className="font-mono">{model}</span>
                      {on ? <span className="text-zinc-500">#{fallbacks.indexOf(model) + 1}</span> : null}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="flex w-fit items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:cursor-wait disabled:opacity-60"
        >
          <FloppyDisk size={13} /> {busy ? "保存中…" : saved ? "已保存" : failed ? "保存失败" : "保存模型策略"}
        </button>
      </div>
    </section>
  );
}
