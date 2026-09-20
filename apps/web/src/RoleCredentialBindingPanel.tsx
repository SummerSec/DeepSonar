import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, CheckCircle, GitBranch, Warning } from "@phosphor-icons/react";
import {
  api,
  type BindableRoleConfig,
  type CredentialBatchBindingResult,
  type CredentialImpact,
  type Project,
  type ProviderAccountCatalogItemView,
  type ProviderCredential,
  type RuntimeImageSummary,
} from "./api";
import { isCurrentAgentCli, isLeftoverAgentCli, type CurrentAgentCli } from "@deepsonar/shared-types";
import { type AgentCli, providerProtocolLabel } from "./CredentialConfigEditor";
import { SearchableSelect } from "./SearchableSelect";
import { runtimeImageSelectOption } from "./runtime-image-option";
import { HelpTip } from "./ui";
import { showToast } from "./toast";
import {
  AGENT_CLI_OPTIONS,
  CLI_LABEL,
  asRoleCli,
  bindingGateReason,
  boundCredentialLabel,
  collectProjectsWithRoleConfigs,
  filterEligibleRoleConfigs,
  groupBindableRoles,
  newBatchIdempotencyKey,
  roleModelLabel,
} from "./provider-account-helpers";
import { CREDENTIAL_ACCOUNT_HREF } from "./settings-tabs";

export function RoleCredentialBindingPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [catalog, setCatalog] = useState<ProviderAccountCatalogItemView[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<BindableRoleConfig[]>([]);
  const [runtimeImages, setRuntimeImages] = useState<RuntimeImageSummary[]>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState(searchParams.get("credential") ?? "");
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(() => new Set());
  const [actorProjectId, setActorProjectId] = useState<string | null>(null);
  const [sourceCredentialId, setSourceCredentialId] = useState("");
  const [mode, setMode] = useState<"bind" | "migrate">("bind");
  const [effect, setEffect] = useState<"new_jobs_only" | "refresh_pending">("new_jobs_only");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [impact, setImpact] = useState<CredentialBatchBindingResult | null>(null);
  const [previewImpact, setPreviewImpact] = useState<CredentialImpact | null>(null);
  const [batchIdempotencyKey, setBatchIdempotencyKey] = useState(newBatchIdempotencyKey);
  const [roleScopeFilter, setRoleScopeFilter] = useState<"all" | "global" | string>("all");

  const selectedCredential = credentials.find((credential) => credential.id === selectedCredentialId) ?? null;
  const boundRoleIds = useMemo(() => {
    if (!selectedCredentialId) return [] as string[];
    return roleConfigs
      .filter((roleConfig) => roleConfig.can_bind && roleConfig.credential_id === selectedCredentialId)
      .map((roleConfig) => roleConfig.id);
  }, [roleConfigs, selectedCredentialId]);
  const boundRoleCount = selectedCredential?.bound_role_config_count ?? boundRoleIds.length;
  const selectedRoles = useMemo(
    () => roleConfigs.filter((roleConfig) => selectedRoleIds.has(roleConfig.id)),
    [roleConfigs, selectedRoleIds],
  );
  const sourceOptions = useMemo(() => {
    const ids = new Set(selectedRoles.map((roleConfig) => roleConfig.credential_id).filter((id): id is string => Boolean(id)));
    return credentials.filter((credential) => ids.has(credential.id));
  }, [credentials, selectedRoles]);
  const targetCatalog = catalog.find((item) => item.provider === selectedCredential?.provider) ?? null;
  const gateReason = bindingGateReason(selectedCredential);
  const eligibleRoleConfigs = useMemo(
    () => filterEligibleRoleConfigs(roleConfigs, roleScopeFilter, selectedCredential?.project_id ?? null),
    [roleConfigs, selectedCredential?.project_id, roleScopeFilter],
  );
  const projectsWithRoleConfigs = useMemo(
    () => collectProjectsWithRoleConfigs(roleConfigs, projects, selectedCredential?.project_id ?? null),
    [roleConfigs, projects, selectedCredential?.project_id],
  );
  const roleBindGroups = useMemo(
    () => groupBindableRoles(eligibleRoleConfigs, projectsWithRoleConfigs, roleScopeFilter),
    [eligibleRoleConfigs, projectsWithRoleConfigs, roleScopeFilter],
  );
  const incompatibleRoles = selectedRoles.filter((roleConfig) => {
    if (gateReason) return true;
    if (!targetCatalog || !targetCatalog.compatible_agent_cli.includes(roleConfig.agent_cli)) return true;
    return false;
  });
  const unbindableSelectedRoles = selectedRoles.filter((roleConfig) => !roleConfig.can_bind);

  const reload = () => {
    api.credentials().then(setCredentials).catch(() => {});
    api.projects().then(setProjects).catch(() => {});
    api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
  };

  useEffect(() => {
    api.authMe().then((me) => setActorProjectId(me.actor?.project_id ?? null)).catch(() => setActorProjectId(null));
    api.credentialProviders().then(setCatalog).catch(() => {});
    reload();
  }, []);

  useEffect(() => {
    if (notice) showToast(notice, "ok");
  }, [notice]);
  useEffect(() => {
    if (error) showToast(error, "error");
  }, [error]);

  useEffect(() => {
    const projectId = roleScopeFilter !== "all" && roleScopeFilter !== "global"
      ? roleScopeFilter
      : selectedCredential?.project_id ?? actorProjectId ?? undefined;
    api.runtimeImages(projectId || undefined).then(setRuntimeImages).catch(() => setRuntimeImages([]));
  }, [roleScopeFilter, selectedCredential?.project_id, actorProjectId]);

  const boundRoleKey = boundRoleIds.slice().sort().join(",");
  useEffect(() => {
    if (!selectedCredentialId) {
      setSelectedRoleIds(new Set());
      return;
    }
    setSelectedRoleIds(new Set(boundRoleKey ? boundRoleKey.split(",") : []));
  }, [selectedCredentialId, boundRoleKey]);

  useEffect(() => {
    if (!selectedCredential) return;
    const candidates = roleConfigs
      .filter((roleConfig) => selectedRoleIds.has(roleConfig.id))
      .map((roleConfig) => roleConfig.credential_id)
      .filter((id): id is string => Boolean(id));
    setSourceCredentialId(candidates.length && new Set(candidates).size === 1 ? candidates[0] : "");
    if (selectedCredential.project_id) setRoleScopeFilter(selectedCredential.project_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-derive when the selected account changes
  }, [selectedCredentialId]);

  useEffect(() => {
    setPreviewImpact(null);
    if (selectedCredentialId) {
      api.credentialImpact(selectedCredentialId).then(setPreviewImpact).catch(() => setPreviewImpact(null));
    }
  }, [selectedCredentialId]);

  const runtimeImageOptionsFor = (projectId: string | null): RuntimeImageSummary[] =>
    runtimeImages
      .filter((image) => {
        if (!image.enabled) return false;
        if (image.official) return true;
        if (projectId) return image.project_enabled === true;
        return false;
      })
      .slice()
      .sort((a, b) => {
        const aBase = a.image_key === "deepsonar-base" ? 0 : a.official ? 1 : 2;
        const bBase = b.image_key === "deepsonar-base" ? 0 : b.official ? 1 : 2;
        if (aBase !== bBase) return aBase - bBase;
        return a.name.localeCompare(b.name, "zh");
      });

  const selectCredential = (id: string) => {
    setSelectedCredentialId(id);
    setImpact(null);
    const next = new URLSearchParams(searchParams);
    if (id) next.set("credential", id);
    else next.delete("credential");
    next.set("tab", "bindings");
    setSearchParams(next, { replace: true });
  };

  const toggleRole = (id: string) => {
    const roleConfig = roleConfigs.find((item) => item.id === id);
    if (!roleConfig?.can_bind) return;
    setSelectedRoleIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setImpact(null);
    setNotice("");
  };

  const apply = async () => {
    if (!selectedCredential || selectedRoleIds.size === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    setImpact(null);
    try {
      if (gateReason) throw new Error(gateReason);
      if (unbindableSelectedRoles.length > 0) throw new Error("项目作用域操作者只能绑定本项目的角色配置。");
      if (mode === "migrate" && !sourceCredentialId) throw new Error("请选择要迁移的源账号");
      if (incompatibleRoles.length > 0) throw new Error("部分所选角色配置与当前账号 CLI 不兼容");
      const checks = await Promise.all(selectedRoles.map((roleConfig) =>
        api.credentialCompatibility(selectedCredential.id, roleConfig.agent_cli, roleConfig.model),
      ));
      const failed = checks.find((check) => !check.compatible);
      if (failed) throw new Error(failed.error ?? "Provider 与 Agent CLI 不兼容");
      const result = await api.bindCredentialsBatch({
        credential_id: selectedCredential.id,
        role_config_ids: [...selectedRoleIds],
        mode,
        ...(mode === "migrate" ? { source_credential_id: sourceCredentialId } : {}),
        effect,
        idempotency_key: batchIdempotencyKey,
      });
      setImpact(result);
      setNotice(effect === "refresh_pending"
        ? `已原子生效。已绑定 ${result.role_config_count} 个角色配置；刷新了 ${result.refreshed_pending_job_count} 个 pending 快照；运行中快照保持冻结。`
        : `已原子生效（仅新 Job）。已绑定 ${result.role_config_count} 个角色配置；已有 pending 与运行中快照保持冻结。`);
      setBatchIdempotencyKey(newBatchIdempotencyKey());
      const [nextRoles, nextImpact] = await Promise.all([
        api.bindableRoleConfigs().catch(() => null),
        api.credentialImpact(selectedCredential.id).catch(() => null),
      ]);
      if (nextRoles) setRoleConfigs(nextRoles);
      if (nextImpact) setPreviewImpact(nextImpact);
      api.credentials().then(setCredentials).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="provider-flow-shell" aria-label="角色凭据绑定">
      <div className="provider-flow-head">
        <div>
          <div className="provider-flow-eyebrow"><GitBranch size={13} weight="bold" /> 绑定域 / 角色凭据</div>
          <h2>把账号绑到角色配置。</h2>
          <p>
            浏览角色不需要先选账号。绑定、换绑或迁移时再选择账号，并显式指定生效范围。
            运行中与终态 Job 快照始终冻结；<code>refresh_pending</code> 只刷新 pending。
          </p>
        </div>
        <Link to={CREDENTIAL_ACCOUNT_HREF} className="provider-flow-lock">去账号管理</Link>
      </div>

      {notice && <div className="provider-flow-notice"><CheckCircle size={15} /> {notice}</div>}
      {error && <div className="provider-flow-error"><Warning size={15} /> {error}</div>}

      <div className="provider-flow-grid">
        <div className="provider-flow-card">
          <div className="provider-flow-card-kicker">目标账号（可选浏览）</div>
          <SearchableSelect
            value={selectedCredentialId}
            onChange={selectCredential}
            options={credentials.map((credential) => ({
              value: credential.id,
              label: `${credential.name} · ${providerProtocolLabel(credential.provider, (credential.agent_cli as AgentCli | null) ?? "claude-code", catalog)} · ${CLI_LABEL[credential.agent_cli ?? ""] ?? credential.agent_cli ?? "CLI 未设"}`,
            }))}
            placeholder="未选择也可浏览角色"
            ariaLabel="选择要绑定的 Provider 账号"
            clearable
          />
          {selectedCredential && (
            <div className="provider-flow-health">
              <strong>{selectedCredential.name}</strong>
              <span>已绑定 {boundRoleCount}</span>
              <span>{CLI_LABEL[selectedCredential.agent_cli ?? ""] ?? selectedCredential.agent_cli ?? "CLI 未设"}</span>
              <Link to={`${CREDENTIAL_ACCOUNT_HREF}`} className="text-[11px] text-acc-300">账号 CLI / 密钥在账号页修改</Link>
            </div>
          )}
          {gateReason && <div className="provider-flow-warning"><Warning size={13} /> {gateReason}</div>}
        </div>

        <div className="provider-flow-card provider-flow-bind-card">
          <div className="provider-flow-card-kicker">角色配置</div>
          <div className="provider-flow-bind-head">
            <div>
              <label className="provider-flow-label">
                按全局 / 项目选择角色配置
                <HelpTip>
                  未选账号时也可浏览。项目列表来自已有项目；若某项目还没有角色覆盖，需先在角色注册表添加项目覆盖。
                  <strong className="provider-flow-role-legend-system"> 系统角色（调度内核）</strong>
                  {" "}与
                  <strong className="provider-flow-role-legend-hub"> Hub</strong>
                  {" "}有颜色区分。
                </HelpTip>
              </label>
              <div className="provider-flow-scope-bar" role="group" aria-label="角色配置作用域">
                <div className="provider-flow-scope-toggles">
                  <button type="button" className={roleScopeFilter === "all" ? "is-active" : ""} onClick={() => setRoleScopeFilter("all")}>全部</button>
                  <button type="button" className={roleScopeFilter === "global" ? "is-active" : ""} onClick={() => setRoleScopeFilter("global")}>全局配置</button>
                </div>
                <SearchableSelect
                  label="项目"
                  ariaLabel="选择项目"
                  value={roleScopeFilter !== "all" && roleScopeFilter !== "global" ? roleScopeFilter : ""}
                  onChange={(next) => setRoleScopeFilter(next || "all")}
                  options={projectsWithRoleConfigs.map((project) => ({
                    value: project.id,
                    label: `${project.name}${project.count > 0 ? `（${project.count} 个覆盖）` : "（尚无覆盖）"}`,
                  }))}
                  placeholder="选择项目…"
                  className="provider-flow-filter-field"
                />
              </div>
            </div>
            <div className="provider-flow-count-stack" aria-label="绑定与勾选数量">
              <div className="provider-flow-count">{boundRoleCount}<span>已绑定</span></div>
              <div className="provider-flow-count is-muted">{selectedRoleIds.size}<span>本次勾选</span></div>
            </div>
          </div>
          <div className="provider-flow-role-list">
            {roleConfigs.length === 0 && <div className="provider-flow-empty">暂无角色配置。请先在「角色注册表」中创建，再回到这里绑定。</div>}
            {roleConfigs.length > 0 && eligibleRoleConfigs.length === 0 && (
              <div className="provider-flow-empty">当前作用域下没有可绑定的角色配置。请切换「全局 / 项目」，或在「角色注册表」中创建配置。</div>
            )}
            {roleBindGroups.map((group) => (
              <div key={group.key} className={`provider-flow-role-group is-${group.kind}`}>
                <div className="provider-flow-role-group-head">
                  <strong>{group.title}</strong>
                  <span>{group.items.length} 个</span>
                </div>
                {group.items.length === 0 && group.emptyHint && (
                  <div className="provider-flow-empty" style={{ margin: "4px 0 0" }}>{group.emptyHint}</div>
                )}
                <div className="provider-flow-role-group-body">
                  {group.items.map((roleConfig) => {
                    const selected = selectedRoleIds.has(roleConfig.id);
                    const roleCli = asRoleCli(roleConfig.agent_cli);
                    const incompatible = Boolean(
                      selectedCredential
                      && targetCatalog
                      && !targetCatalog.compatible_agent_cli.includes(roleCli),
                    );
                    const boundCredential = credentials.find((credential) => credential.id === roleConfig.credential_id) ?? null;
                    const modelCredential = roleConfig.credential_id ? boundCredential : selectedCredential;
                    const accent = roleConfig.role_ui_color?.trim() || undefined;
                    const canToggle = roleConfig.can_bind && !incompatible;
                    const isSystem = roleConfig.role_kind === "system";
                    const isHub = roleConfig.role_kind === "hub";
                    const isBuiltin = roleConfig.role_builtin;
                    return (
                      <div
                        key={roleConfig.id}
                        className={[
                          "provider-flow-role",
                          selected ? "is-selected" : "",
                          isSystem ? "is-system" : "",
                          isHub ? "is-hub" : "",
                          isBuiltin && !isSystem && !isHub ? "is-builtin" : "",
                          !canToggle ? "is-disabled-bind" : "",
                        ].filter(Boolean).join(" ")}
                        style={accent && !isSystem && !isHub ? { ["--role-accent" as string]: accent } : undefined}
                        data-role-kind={roleConfig.role_kind}
                        onClick={() => { if (canToggle) toggleRole(roleConfig.id); }}
                        onKeyDown={(event) => {
                          if (!canToggle) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleRole(roleConfig.id);
                          }
                        }}
                        role="checkbox"
                        aria-checked={selected}
                        tabIndex={canToggle ? 0 : -1}
                      >
                        <span className="provider-flow-role-check" aria-hidden><Check size={11} weight="bold" /></span>
                        <span className="provider-flow-role-main">
                          <strong>
                            {roleConfig.role_title || roleConfig.role_name}
                            {isSystem && <em className="provider-flow-role-badge is-system">系统角色（调度内核）</em>}
                            {isHub && <em className="provider-flow-role-badge is-hub">Hub 中枢</em>}
                            {isBuiltin && !isSystem && !isHub && <em className="provider-flow-role-badge is-builtin">内置</em>}
                          </strong>
                          <small>
                            {group.kind === "project" ? (roleConfig.project_name ?? "项目") : "全局默认"}
                            {isSystem ? " · 调度内核" : isHub ? " · Hub" : ""}
                          </small>
                        </span>
                        <fieldset
                          className="provider-flow-role-cli-wrap"
                          disabled={busy || !roleConfig.can_bind}
                          title="修改此角色配置的 Agent CLI（立即保存）"
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          <span className="provider-flow-role-cli-caption">CLI</span>
                          <SearchableSelect
                            value={roleCli}
                            ariaLabel={`${roleConfig.role_title || roleConfig.role_name} 的 Agent CLI`}
                            onChange={(next) => {
                              if (!next || next === roleCli || !isCurrentAgentCli(next)) return;
                              void (async () => {
                                setBusy(true);
                                setError("");
                                try {
                                  await api.updateRoleConfigAgentCli(roleConfig.id, next as CurrentAgentCli);
                                  setRoleConfigs((current) =>
                                    current.map((item) => item.id === roleConfig.id ? { ...item, agent_cli: next as CurrentAgentCli } : item),
                                  );
                                  setNotice(`已将「${roleConfig.role_title || roleConfig.role_name}」CLI 改为 ${CLI_LABEL[next] ?? next}`);
                                  api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
                                } catch (e) {
                                  setError(String(e));
                                } finally {
                                  setBusy(false);
                                }
                              })();
                            }}
                            options={[
                              ...AGENT_CLI_OPTIONS.map((option) => ({ ...option, label: option.value })),
                              ...(isLeftoverAgentCli(roleCli) ? [{ value: roleCli, label: `${roleCli}（已停用）` }] : []),
                            ]}
                            placeholder="选择 CLI…"
                            className="w-full min-w-0 [&>button]:!min-h-[32px] [&>button]:w-full [&>button]:min-w-0"
                            clearable={false}
                          />
                        </fieldset>
                        {roleConfig.project_id ? (
                          <span
                            className="provider-flow-role-cli-wrap provider-flow-role-image-wrap"
                            title="项目 RoleConfig 的镜像由设置中的角色缺省决定"
                            onClick={(event) => event.stopPropagation()}
                            onMouseDown={(event) => event.stopPropagation()}
                          >
                            <span className="provider-flow-role-cli-caption">镜像</span>
                            <span className="provider-flow-role-image-readonly">由项目镜像缺省决定</span>
                          </span>
                        ) : (
                          <div
                            className="provider-flow-role-cli-wrap provider-flow-role-image-wrap"
                            onClick={(event) => event.stopPropagation()}
                            onMouseDown={(event) => event.stopPropagation()}
                          >
                            <span className="provider-flow-role-cli-caption">镜像</span>
                            <SearchableSelect
                              value={roleConfig.runtime_image_key ?? ""}
                              onChange={(value) => {
                                if (busy || !roleConfig.can_bind) return;
                                const next = value.trim() || null;
                                if (next === (roleConfig.runtime_image_key ?? null)) return;
                                void (async () => {
                                  setBusy(true);
                                  setError("");
                                  try {
                                    await api.updateRoleConfigRuntimeImage(roleConfig.id, next);
                                    setRoleConfigs((currentRows) =>
                                      currentRows.map((item) => item.id === roleConfig.id ? { ...item, runtime_image_key: next } : item),
                                    );
                                    const label = next
                                      ? (runtimeImages.find((image) => image.image_key === next)?.name ?? next)
                                      : "系统底座";
                                    setNotice(`已将「${roleConfig.role_title || roleConfig.role_name}」镜像改为 ${label}`);
                                    api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
                                  } catch (e) {
                                    setError(String(e));
                                  } finally {
                                    setBusy(false);
                                  }
                                })();
                              }}
                              options={[
                                { value: "", label: "系统底座（默认）", disabled: busy || !roleConfig.can_bind },
                                ...runtimeImageOptionsFor(roleConfig.project_id).map((image) => (
                                  runtimeImageSelectOption(image, roleConfig.project_id, busy || !roleConfig.can_bind)
                                )),
                                ...(roleConfig.runtime_image_key
                                  && !runtimeImageOptionsFor(roleConfig.project_id).some((image) => image.image_key === roleConfig.runtime_image_key)
                                  ? [{
                                      value: roleConfig.runtime_image_key,
                                      label: roleConfig.runtime_image_key,
                                      hint: "当前 · 需检查启用",
                                      disabled: busy || !roleConfig.can_bind,
                                    }]
                                  : []),
                              ]}
                              placeholder="系统底座（默认）"
                              ariaLabel={`${roleConfig.role_title || roleConfig.role_name} 的运行镜像`}
                              className="w-full min-w-0 [&>button]:!min-h-[32px] [&>button]:w-full [&>button]:min-w-0"
                            />
                          </div>
                        )}
                        <span className="provider-flow-role-meta">
                          <span
                            className={`provider-flow-role-status ${incompatible || !roleConfig.can_bind || (roleConfig.credential_id && roleConfig.credential_id !== selectedCredential?.id) ? "is-warning" : roleConfig.credential_name ? "is-bound" : ""}`}
                            title={
                              !roleConfig.can_bind
                                ? "全局角色配置可见，但项目操作者只能绑定本项目角色配置"
                                : incompatible
                                  ? `请选择与 ${CLI_LABEL[roleCli] ?? roleCli} 兼容的 Provider`
                                  : boundCredentialLabel(roleConfig, selectedCredential?.id ?? null)
                            }
                          >
                            {!roleConfig.can_bind
                              ? "只读 · 项目作用域"
                              : incompatible
                                ? "Provider 不兼容 · 可改 CLI"
                                : boundCredentialLabel(roleConfig, selectedCredential?.id ?? null)}
                          </span>
                          <span className="provider-flow-role-model" title={roleModelLabel(roleConfig, modelCredential)}>
                            {roleModelLabel(roleConfig, modelCredential)}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="provider-flow-card provider-flow-effect-card">
          <div className="provider-flow-card-kicker">生效策略（绑定域提交）</div>
          <div className="provider-flow-effect-grid">
            <div>
              <label className="provider-flow-label">绑定操作</label>
              <div className="provider-flow-toggle-group">
                <button type="button" className={mode === "bind" ? "is-active" : ""} onClick={() => setMode("bind")}>绑定账号</button>
                <button type="button" className={mode === "migrate" ? "is-active" : ""} onClick={() => setMode("migrate")}>从账号迁移</button>
              </div>
              {mode === "migrate" && (
                <SearchableSelect
                  value={sourceCredentialId}
                  onChange={setSourceCredentialId}
                  options={sourceOptions.map((credential) => ({
                    value: credential.id,
                    label: `${credential.name} · ${providerProtocolLabel(credential.provider, (credential.agent_cli as AgentCli | null) ?? "claude-code", catalog)}`,
                  }))}
                  placeholder="选择源账号"
                  ariaLabel="选择迁移源账号"
                  className="mt-2"
                />
              )}
            </div>
            <div>
              <label className="provider-flow-label">
                何时生效？
                <HelpTip>运行中与终态 Job 始终保留冻结快照。「刷新 pending」需显式选择且有边界。</HelpTip>
              </label>
              <div className="provider-flow-toggle-group">
                <button type="button" className={effect === "new_jobs_only" ? "is-active" : ""} onClick={() => setEffect("new_jobs_only")}>仅新 Job</button>
                <button type="button" className={effect === "refresh_pending" ? "is-active" : ""} onClick={() => setEffect("refresh_pending")}>刷新 pending</button>
              </div>
            </div>
          </div>
          {incompatibleRoles.length > 0 && selectedRoleIds.size > 0 && (
            <div className="provider-flow-warning">
              <Warning size={14} /> 已选 {incompatibleRoles.length} 个角色配置与当前账号 CLI 不兼容。请更换账号或角色。
            </div>
          )}
          <button
            type="button"
            onClick={apply}
            disabled={busy || !selectedCredential || selectedRoleIds.size === 0 || Boolean(gateReason) || incompatibleRoles.length > 0 || unbindableSelectedRoles.length > 0}
            className="provider-flow-apply"
          >
            {busy ? "正在检查兼容性…" : <><GitBranch size={15} /> 应用到所选角色配置</>}
          </button>
        </div>

        {impact && (
          <div className="provider-flow-impact" role="status">
            <div className="provider-flow-impact-title"><CheckCircle size={16} /> 已在同一事务中生效</div>
            <div className="provider-flow-impact-grid">
              <span><strong>{impact.role_config_count}</strong> 本次绑定角色配置</span>
              <span><strong>{previewImpact?.role_configs.count ?? boundRoleCount}</strong> 当前已绑定</span>
              <span><strong>{impact.pending_job_count}</strong> pending</span>
              <span><strong>{impact.refreshed_pending_job_count}</strong> 已刷新</span>
              <span><strong>{impact.active_frozen_job_count}</strong> 活跃冻结</span>
              <span><strong>{impact.terminal_historical_job_count}</strong> 终态 / 重试</span>
            </div>
          </div>
        )}
        {previewImpact && (
          <div className="provider-flow-preview" role="status">
            <div className="provider-flow-impact-title"><GitBranch size={15} /> 当前账号影响预览</div>
            <div className="provider-flow-impact-grid">
              <span><strong>{previewImpact.role_configs.count}</strong> 已绑定角色配置</span>
              <span><strong>{previewImpact.jobs.pending_unclaimed.count}</strong> pending 冻结</span>
              <span><strong>{previewImpact.jobs.active_frozen.count}</strong> 活跃冻结</span>
              <span><strong>{previewImpact.jobs.recoverable.count}</strong> 可恢复</span>
              <span><strong>{previewImpact.jobs.terminal_historical.count}</strong> 终态</span>
              <span><strong>{previewImpact.scans.active.count}</strong> 活动扫描</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
