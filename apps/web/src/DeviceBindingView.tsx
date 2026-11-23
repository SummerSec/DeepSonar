import type { JobAttemptSummary } from "./api";
import { leaseStateLabel } from "./devices";

const labels = {
  not_declared: "未绑定设备（未声明需求）",
  not_attempted: "尚未申请租约",
  not_applying: "当前角色无需设备",
  attempted_no_lease: "本次执行暂无租约记录",
  acquire_failed: "设备租约申请失败",
  lease_unrecorded: "未记录租约申请结果",
  lease_recorded_unverified: "已记录租约，连接未验证",
};

type Verdict = { state: keyof typeof labels; reason: string };
type Lease = { attempt_id: string | null; state: string; device_key: string | null; rig_id: string | null };
export interface DeviceBinding extends Verdict {
  canvas_requirement: { transport: string } | null;
  snapshot_requirement: { transport: string } | null;
  role_matched: boolean;
  attempts: Array<Verdict & { attempt_id: string; attempt_no: number | null }>;
  attempts_truncated: boolean;
  leases: Lease[];
  leases_truncated: boolean;
  lease_count: number;
}

function bindingLabel(state: Verdict["state"], binding: DeviceBinding) {
  if (state === "not_declared" || state === "not_attempted") {
    if (binding.canvas_requirement && !binding.snapshot_requirement) return "未绑定设备（运行快照未包含画布需求）";
    if (binding.snapshot_requirement && !binding.role_matched) return labels.not_applying;
  }
  return labels[state];
}

export function DeviceBindingView({ binding, attempts }: {
  binding?: DeviceBinding;
  attempts: ReadonlyArray<Pick<JobAttemptSummary, "id" | "error">>;
}) {
  if (!binding) return null;
  const attemptNumbers = new Map(binding.attempts.map(row => [row.attempt_id, row.attempt_no]));
  return (
    <details className="mt-3 text-[12px] text-zinc-400">
      <summary className="cursor-pointer">设备绑定 · {bindingLabel(binding.state, binding)}</summary>
      {binding.attempts.length === 0 && <p className="mt-2">{binding.reason}</p>}
      <ol className="mt-2 space-y-2">
        {binding.attempts.map(row => {
          const error = row.state === "acquire_failed" && attempts.find(attempt => attempt.id === row.attempt_id)?.error;
          return (
            <li key={row.attempt_id} className="break-words">
              <strong>第 {row.attempt_no ?? "?"} 次执行 · {bindingLabel(row.state, binding)}</strong>
              <p>{row.reason}</p>
              {error && <p>{error}</p>}
            </li>
          );
        })}
      </ol>
      {binding.attempts_truncated && <p>仅显示最近 {binding.attempts.length} 次执行的诊断。</p>}
      {binding.leases.length > 0 && <ul className="mt-2 space-y-1">
        {binding.leases.map((lease, index) => (
          <li key={index} className="break-words">
            {lease.attempt_id ? `执行 ${attemptNumbers.get(lease.attempt_id) ?? lease.attempt_id}` : "执行归属未知"}
            {" · "}{lease.rig_id ?? "未知设备组"} / {lease.device_key ?? "未知设备"} · {leaseStateLabel(lease.state)}
          </li>
        ))}
      </ul>}
      {binding.leases_truncated && <p>共 {binding.lease_count} 条租约，仅显示最近 {binding.leases.length} 条。</p>}
    </details>
  );
}
