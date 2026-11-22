import type { JobAttemptSummary } from "./api";

interface BindingStatus {
  state: "not_declared" | "declared_no_lease" | "lease_recorded_unverified";
  reason: string;
}

export interface BindingDiagnostics extends BindingStatus {
  role_matched: boolean;
  snapshot_requirement: { transport: string } | null;
  attempts: Array<BindingStatus & { attempt_id: string; attempt_no: number | null }>;
  attempts_truncated: boolean;
  leases_truncated: boolean;
}

type Attempt = Pick<JobAttemptSummary, "id" | "error" | "outcome_json">;

function describe(binding: BindingDiagnostics, row: BindingStatus, attempt?: Attempt) {
  if (row.state === "lease_recorded_unverified") return { title: "已记录租约，连接未验证", detail: row.reason };
  if (row.state === "not_declared") return { title: "未绑定设备", detail: row.reason };
  if (!binding.snapshot_requirement) return { title: "设备需求未写入本次运行", detail: row.reason };
  if (!binding.role_matched) return { title: "当前角色无需设备", detail: row.reason };
  const failure = attempt?.outcome_json?.reason;
  if (failure === "device_not_available" || failure === "device_not_authorized") {
    return { title: "租约申请失败", detail: attempt?.error || failure };
  }
  return { title: "暂无租约记录", detail: row.reason };
}

export function DeviceBindingView({ binding, attempts }: { binding?: BindingDiagnostics; attempts: Attempt[] }) {
  if (!binding) return null;
  const byId = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const current = describe(binding, binding, byId.get(binding.attempts[0]?.attempt_id ?? ""));
  return <details className="mt-3 text-[12px] text-zinc-400">
    <summary>设备绑定 · {current.title}</summary>
    <p className="my-2 break-words">{current.detail}</p>
    {binding.attempts.length > 1 && <ul className="space-y-2">
      {binding.attempts.map(row => {
        const status = describe(binding, row, byId.get(row.attempt_id));
        return <li key={row.attempt_id}>
          <div>第 {row.attempt_no ?? "?"} 次执行 · {status.title}</div>
          <div className="break-words">{status.detail}</div>
        </li>;
      })}
    </ul>}
    {(binding.attempts_truncated || binding.leases_truncated) && <p>仅展示最近的执行和租约记录。</p>}
  </details>;
}
