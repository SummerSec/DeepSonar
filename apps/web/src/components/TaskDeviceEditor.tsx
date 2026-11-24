import { DeviceRequirement } from "@deepsonar/shared-types";
import { SearchableSelect } from "../SearchableSelect";

export interface TaskDeviceDraft {
  transport: "" | "adb" | "hdc";
  rigId: string;
  key: string;
  roles: string;
}

export const EMPTY_TASK_DEVICE: TaskDeviceDraft = { transport: "", rigId: "", key: "", roles: "test" };

export function parseTaskDevice(draft: TaskDeviceDraft) {
  if (!draft.transport) return { device: undefined, error: null };
  const parsed = DeviceRequirement.safeParse({
    transport: draft.transport,
    ...(draft.rigId.trim() ? { rig_id: draft.rigId.trim() } : {}),
    ...(draft.key.trim() ? { key: draft.key.trim() } : {}),
    roles: [...new Set(draft.roles.split(",").map(role => role.trim()).filter(Boolean))],
  });
  return parsed.success
    ? { device: parsed.data, error: null }
    : { device: undefined, error: parsed.error.issues[0]?.message ?? "请检查设备需求" };
}

export function TaskDeviceEditor({ value, onChange }: { value: TaskDeviceDraft; onChange: (draft: TaskDeviceDraft) => void }) {
  const { error } = parseTaskDevice(value);
  return (
    <fieldset className="min-w-0 space-y-3 rounded-xl border border-white/[.06] p-4">
      <legend className="px-1 text-[12px] text-zinc-300">本次任务设备需求</legend>
      <SearchableSelect
        value={value.transport}
        onChange={transport => onChange({ ...value, transport: transport as TaskDeviceDraft["transport"] })}
        options={[{ value: "", label: "无需设备" }, { value: "hdc", label: "OpenHarmony / HarmonyOS（hdc）" }, { value: "adb", label: "Android（adb）" }]}
        ariaLabel="设备连接方式"
        placeholder="无需设备"
        clearable={false}
        className="block [&>button]:w-full"
      />
      {value.transport && <>
        <label className="block text-[12px] text-zinc-400">设备组
          <input value={value.rigId} onChange={event => onChange({ ...value, rigId: event.target.value })} maxLength={32} placeholder="留空使用平台默认设备组" className="theme-input-surface mt-1 w-full border px-3 py-2" />
        </label>
        <label className="block text-[12px] text-zinc-400">设备标识
          <input value={value.key} onChange={event => onChange({ ...value, key: event.target.value })} maxLength={200} placeholder="留空由设备代理分配" className="theme-input-surface mt-1 w-full border px-3 py-2" />
        </label>
        <label className="block text-[12px] text-zinc-400">需要设备的角色名
          <input value={value.roles} onChange={event => onChange({ ...value, roles: event.target.value })} placeholder="test，多个角色用英文逗号分隔" className="theme-input-surface mt-1 w-full border px-3 py-2" />
        </label>
        <p className="text-[11px] leading-5 text-zinc-500">设备需求会保存到本次任务，仅匹配的角色申请独占租约。项目须已启用设备接入并允许出网，创建时由平台核验授权。</p>
      </>}
      {error && <p role="alert" className="text-[12px] text-red-300">{error}</p>}
    </fieldset>
  );
}
