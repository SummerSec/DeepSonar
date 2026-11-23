import { DeviceRequirement } from "@deepsonar/shared-types";
import { readRigAdmission, rowRigId, type RigAdmissionState } from "./rig-registry.js";
import { judgeRequiredDeviceCapability, type DeviceCapabilityVerdict, type JudgedDeviceRow } from "./capability-judge.js";

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/** 画布上声明的设备要求（与 dispatcher 冻结需求的同一来源，不改写快照）。 */
export function canvasDeviceRequirement(targetJson: unknown): { transport: string; key: string | null; model: string | null; rig_id: string | null; roles: string[] } | null {
  const raw = (targetJson as Record<string, unknown> | null | undefined)?.device_requirement;
  if (!raw || typeof raw !== "object") return null;
  const parsed = DeviceRequirement.safeParse(raw);
  if (!parsed.success) return null;
  return { transport: parsed.data.transport, key: parsed.data.key ?? null, model: parsed.data.model ?? null,
    rig_id: parsed.data.rig_id ?? null, roles: [...parsed.data.roles] };
}

/**
 * 补证前的能力判定。**失败一律回报未知**：判定本身出问题不能变成「能力不可用」，
 * 否则护栏会用一次平台故障把 Finding 直接推给人工。
 */
export async function gateVerifyRoundDeviceCapability(
  db: unknown,
  input: { canvasId: string | null; roleName: string },
): Promise<{ verdict: DeviceCapabilityVerdict; requirement: ReturnType<typeof canvasDeviceRequirement> | null }> {
  if (!input.canvasId) return { verdict: { state: "unknown", reason: "任务画布未知，不做能力判定" }, requirement: null };
  const sql = db as Sql;
  try {
    const [canvas] = await sql`SELECT target_json FROM canvases WHERE id=${input.canvasId}`;
    const requirement = canvasDeviceRequirement(canvas?.target_json);
    if (!requirement) return { verdict: { state: "unknown", reason: "任务没有声明设备要求，不适用设备能力判定" }, requirement: null };
    if (!requirement.roles.includes(input.roleName)) {
      return { verdict: { state: "unknown", reason: `角色 ${input.roleName} 不在设备要求的角色内，不适用` }, requirement };
    }
    const rows = await sql`SELECT key, transport, model, rig_id FROM devices WHERE transport=${requirement.transport}`;
    const devices: JudgedDeviceRow[] = rows.map((row) => ({ key: String(row.key), transport: String(row.transport),
      model: (row.model as string | null) ?? null, rig_id: rowRigId(row as { rig_id?: string | null }) }));
    const scoped = requirement.rig_id ? devices.filter((row) => row.rig_id === requirement.rig_id) : devices;
    const rigs = [...new Set(scoped.filter((row) => row.transport === requirement.transport).map((row) => row.rig_id))];
    const admitted: Record<string, RigAdmissionState | null> = {};
    for (const rig of rigs) admitted[rig] = await readRigAdmission(rig).catch(() => null);
    return { verdict: judgeRequiredDeviceCapability({ requirement, devices, admitted }), requirement };
  } catch (error) {
    return { verdict: { state: "unknown", reason: `能力判定未能执行：${error instanceof Error ? error.message.slice(0, 80) : "unknown"}` }, requirement: null };
  }
}
