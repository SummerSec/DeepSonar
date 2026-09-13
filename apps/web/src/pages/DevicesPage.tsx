import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { DeviceEvent, DeviceLease, DeviceRegistry, DeviceSummary } from "../api";
import { useAuth } from "../auth";
import { canAccessAnyScope } from "../permissions";
import {
  DEVICE_TRANSPORT_OPTIONS,
  deviceActionLabel,
  deviceCanManage,
  deviceErrorCode,
  deviceRemedyHint,
  deviceStatusLabel,
  deviceStatusTone,
  leaseIsActive,
  leaseStateLabel,
  rigAdmissionSummary,
} from "../devices";
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  SectionHeading,
  formatTime,
  tdCls,
  thCls,
  trHover,
} from "../ui";

const TONE_CLS: Record<string, string> = {
  ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  warn: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  danger: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  muted: "border-zinc-600/40 bg-zinc-600/10 text-zinc-400",
};

function ToneBadge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${TONE_CLS[tone] ?? TONE_CLS.muted}`}
    >
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLS =
  "rounded-md border border-zinc-700/60 bg-zinc-900/60 px-3 py-2 text-[13px] text-zinc-100 outline-none focus:border-zinc-500";

/**
 * 真实设备准入（#505）：平台是权威 —— 登记 / 下架 / 删除都会把期望集合重推给 rig。
 * 有在途租约时不能下架或删除；有租约历史的登记项只能下架（审计不可删），页面按错误码给出补救提示。
 */
export function DevicesPage() {
  const { me } = useAuth();
  const [registry, setRegistry] = useState<DeviceRegistry | null>(null);
  const [leases, setLeases] = useState<DeviceLease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [eventsFor, setEventsFor] = useState<string | null>(null);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [form, setForm] = useState({ key: "", transport: "adb", model: "" });

  const canRead = canAccessAnyScope(me, ["tasks:read"]);
  const canManage = deviceCanManage(me);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextRegistry, nextLeases] = await Promise.all([api.deviceRegistry(), api.deviceLeases()]);
      setRegistry(nextRegistry);
      setLeases(nextLeases.leases);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canRead) void load();
    else setLoading(false);
  }, [canRead, load]);

  const runAction = useCallback(
    async (id: string, action: () => Promise<unknown>, successNotice: string) => {
      setBusy(id);
      setError(null);
      setNotice(null);
      try {
        await action();
        setNotice(successNotice);
        setConfirmingDelete(null);
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const devices = registry?.devices ?? [];
  const activeLeaseCount = useMemo(() => leases.filter((lease) => leaseIsActive(lease.state)).length, [leases]);
  const remedy = deviceRemedyHint(deviceErrorCode(error));

  const submitRegister = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    const key = form.key.trim();
    if (!key) {
      setError("INVALID_BODY: 设备 key（broker 侧设备句柄，通常是序列号）不能为空");
      return;
    }
    setBusy("register");
    setError(null);
    setNotice(null);
    try {
      await api.registerDevice({
        key,
        transport: form.transport,
        model: form.model.trim() ? form.model.trim() : null,
      });
      setNotice(`已登记 ${key}，并把期望集合推给 rig`);
      setForm({ key: "", transport: form.transport, model: "" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleEvents = async (device: DeviceSummary) => {
    if (eventsFor === device.id) {
      setEventsFor(null);
      setEvents([]);
      return;
    }
    setEventsFor(device.id);
    setEvents([]);
    try {
      const payload = await api.deviceEvents(device.id);
      setEvents(payload.events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!canRead) {
    return (
      <div className="page-scroll px-5 pt-7 sm:px-9 sm:pt-9">
        <PageHeader
          title="设备"
          eyebrow="PLATFORM / DEVICES"
          subtitle="真实设备经 device broker 暴露为可租借端点；本页需要 tasks:read。"
        />
        <EmptyState title="无权访问设备准入" hint="当前主体的 scope 不包含 tasks:read。" />
      </div>
    );
  }

  return (
    <div className="page-scroll flex flex-col gap-6 px-5 pt-7 pb-10 sm:px-9 sm:pt-9">
      <PageHeader
        title="设备"
        eyebrow="PLATFORM / DEVICES"
        subtitle="平台是设备准入的权威：登记、下架与删除都会把期望集合整集推给 rig 的 broker。有在途租约时不能下架或删除；有租约历史的登记项只能下架。"
      />

      <section className="flex flex-col gap-2 rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-4">
        <SectionHeading title="rig 准入" meta={registry?.rig.enabled ? "enabled" : "disabled"} />
        <p className="text-[13px] text-zinc-400">{rigAdmissionSummary(registry?.rig)}</p>
        <p className="font-mono text-[11px] text-zinc-500">
          transports={registry?.rig.transports.join(",") ?? "-"} · devices={devices.length} · active_leases={activeLeaseCount}
        </p>
      </section>

      {canManage ? (
        <section className="flex flex-col gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-4">
          <SectionHeading title="登记设备" meta="POST /devices" />
          <form className="flex flex-wrap items-end gap-3" onSubmit={submitRegister}>
            <Field label="key（broker 侧设备句柄）">
              <input
                className={INPUT_CLS}
                value={form.key}
                onChange={(changeEvent) => setForm({ ...form, key: changeEvent.target.value })}
                placeholder="EE5TAEYLRK6XQGZP"
              />
            </Field>
            {/* Web 守则：下拉必须用可搜索选择原语（`ci:unit:searchable-selects`），不用原生 select。 */}
            <FilterSelect
              value={form.transport}
              onChange={(value) => setForm({ ...form, transport: value })}
              options={DEVICE_TRANSPORT_OPTIONS}
              placeholder="transport"
              label="transport"
            />
            <Field label="model（可选）">
              <input
                className={INPUT_CLS}
                value={form.model}
                onChange={(changeEvent) => setForm({ ...form, model: changeEvent.target.value })}
                placeholder="Pixel-7"
              />
            </Field>
            <PrimaryButton type="submit" busy={busy === "register"}>
              登记并同步 rig
            </PrimaryButton>
          </form>
          <p className="text-[12px] text-zinc-500">
            留空 project 表示平台共享池；登记是幂等 upsert（同一 key 覆盖 transport 与状态）。
          </p>
        </section>
      ) : (
        <p className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-4 text-[13px] text-zinc-400">
          当前主体没有 <span className="font-mono text-zinc-300">admin</span> scope，只能查看设备与租约。
        </p>
      )}

      {notice ? (
        <p className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-[13px] text-emerald-200">{notice}</p>
      ) : null}
      {error ? (
        <div className="rounded-md border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[13px] text-rose-200">
          <p className="font-mono text-[11px]">{error}</p>
          {remedy ? <p className="mt-1 text-rose-100">{remedy}</p> : null}
        </div>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionHeading title="登记项" meta={`${devices.length} 台`} action={<SecondaryButton onClick={() => void load()}>刷新</SecondaryButton>} />
        {loading ? (
          <p className="text-[13px] text-zinc-500">加载中…</p>
        ) : devices.length === 0 ? (
          <EmptyState
            title="还没有登记设备"
            hint={canManage ? "用上方表单登记设备的 broker 侧句柄；登记后平台会把它下发给 rig。" : "当前没有登记项。"}
          />
        ) : (
          <DataTable>
            <thead>
              <tr>
                <th className={thCls}>key</th>
                <th className={thCls}>transport</th>
                <th className={thCls}>model</th>
                <th className={thCls}>状态</th>
                <th className={thCls}>在途租约</th>
                <th className={thCls}>更新时间</th>
                <th className={thCls}>操作</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id} className={trHover}>
                  <td className={tdCls}>
                    <span className="font-mono text-[12px] text-zinc-200">{device.key}</span>
                    <p className="font-mono text-[10px] text-zinc-500">{device.project_id ?? "平台共享池"}</p>
                  </td>
                  <td className={tdCls}>{device.transport}</td>
                  <td className={tdCls}>{device.model ?? "-"}</td>
                  <td className={tdCls}>
                    <ToneBadge tone={deviceStatusTone(device.status)}>{deviceStatusLabel(device.status)}</ToneBadge>
                  </td>
                  <td className={tdCls}>
                    {device.lease_id ? (
                      <span className="font-mono text-[11px] text-amber-200">
                        {leaseStateLabel(device.lease_state)} · {device.lease_job_id?.slice(0, 8)}
                      </span>
                    ) : (
                      <span className="text-zinc-500">-</span>
                    )}
                  </td>
                  <td className={tdCls}>{formatTime(device.updated_at)}</td>
                  <td className={tdCls}>
                    <div className="flex flex-wrap items-center gap-2">
                      <SecondaryButton onClick={() => void toggleEvents(device)}>
                        {eventsFor === device.id ? "收起事件" : "事件"}
                      </SecondaryButton>
                      {canManage ? (
                        <>
                          {device.status === "revoked" || device.status === "maintenance" ? (
                            <SecondaryButton
                              disabled={busy === device.id}
                              onClick={() =>
                                void runAction(device.id, () => api.setDeviceStatus(device.id, "enable"), `已启用 ${device.key}`)
                              }
                            >
                              启用
                            </SecondaryButton>
                          ) : (
                            <SecondaryButton
                              disabled={busy === device.id}
                              onClick={() =>
                                void runAction(
                                  device.id,
                                  () => api.setDeviceStatus(device.id, "maintenance"),
                                  `已把 ${device.key} 转为维护（不再下发给 rig）`,
                                )
                              }
                            >
                              转维护
                            </SecondaryButton>
                          )}
                          <SecondaryButton
                            disabled={busy === device.id}
                            onClick={() =>
                              void runAction(device.id, () => api.setDeviceStatus(device.id, "revoke"), `已下架 ${device.key}`)
                            }
                          >
                            下架
                          </SecondaryButton>
                          {confirmingDelete === device.id ? (
                            <PrimaryButton
                              busy={busy === device.id}
                              onClick={() =>
                                void runAction(device.id, () => api.deleteDevice(device.id), `已删除登记项 ${device.key}`)
                              }
                            >
                              确认删除
                            </PrimaryButton>
                          ) : (
                            <SecondaryButton disabled={busy === device.id} onClick={() => setConfirmingDelete(device.id)}>
                              删除
                            </SecondaryButton>
                          )}
                        </>
                      ) : null}
                    </div>
                    {eventsFor === device.id ? (
                      <div className="mt-2 flex flex-col gap-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
                        {events.length === 0 ? (
                          <p className="text-[12px] text-zinc-500">没有事件。</p>
                        ) : (
                          events.map((deviceEvent) => (
                            <p key={deviceEvent.id} className="font-mono text-[11px] text-zinc-400">
                              {formatTime(deviceEvent.created_at)} · {deviceEvent.action} · {deviceEvent.actor}
                            </p>
                          ))
                        )}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading title="设备租约" meta={`${leases.length} 条（在途 ${activeLeaseCount}）`} />
        {leases.length === 0 ? (
          <EmptyState title="还没有设备租约" hint="Job 命中设备需求时会在这里出现租约；人工抢回也在这里操作。" />
        ) : (
          <DataTable>
            <thead>
              <tr>
                <th className={thCls}>设备</th>
                <th className={thCls}>状态</th>
                <th className={thCls}>job</th>
                <th className={thCls}>到期</th>
                <th className={thCls}>释放原因</th>
                <th className={thCls}>操作</th>
              </tr>
            </thead>
            <tbody>
              {leases.map((lease) => (
                <tr key={lease.id} className={trHover}>
                  <td className={tdCls}>
                    <span className="font-mono text-[12px] text-zinc-200">{lease.device_key}</span>
                    <p className="font-mono text-[10px] text-zinc-500">{lease.device_transport}</p>
                  </td>
                  <td className={tdCls}>
                    <ToneBadge tone={leaseIsActive(lease.state) ? "warn" : "muted"}>{leaseStateLabel(lease.state)}</ToneBadge>
                  </td>
                  <td className={tdCls}>
                    <span className="font-mono text-[11px] text-zinc-400">{lease.job_id.slice(0, 8)}</span>
                  </td>
                  <td className={tdCls}>{lease.expires_at ? formatTime(lease.expires_at) : "-"}</td>
                  <td className={tdCls}>{lease.release_reason ?? "-"}</td>
                  <td className={tdCls}>
                    {canManage && leaseIsActive(lease.state) ? (
                      <SecondaryButton
                        disabled={busy === lease.id}
                        onClick={() =>
                          void runAction(
                            lease.id,
                            () => api.releaseDeviceLease(lease.id),
                            `已强制释放 ${lease.device_key} 的租约，设备回到空闲`,
                          )
                        }
                      >
                        强制释放
                      </SecondaryButton>
                    ) : (
                      <span className="text-zinc-500">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>

      <p className="text-[12px] text-zinc-500">
        提示：下架（{deviceActionLabel("revoke")}）会把设备移出 rig 准入集合但保留审计；删除只适用于从未租用过的登记项。
      </p>
    </div>
  );
}
