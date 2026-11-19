export interface RuntimeProcessEvidence {
  audit_id: string;
  observed_at: string;
  observation: {
    attempt_id: string;
    sandbox_id: string;
    process_id: string | null;
    termination: string;
    host_kill_caller: string | null;
    exit_code: number | null;
    cleanup: { outcome: string; http_status: number | null } | null;
  };
  sandbox_cleanup: { outcome: string; automatic_recovery: string } | null;
}

const OUTCOMES: Record<string, string> = { confirmed: "已确认", http_error: "HTTP 拒绝", transport_error: "传输失败",
  timeout: "超时，结果未知", destroy_failed: "销毁失败，结果未知" };
const TERMINATIONS: Record<string, string> = { process_exit: "进程退出", transport_closed: "连接关闭",
  transport_error: "连接错误", protocol_error: "退出信息无效", host_kill: "宿主请求结束",
  connect_timeout: "连接超时", create_error: "创建进程失败" };
const CALLERS: Record<string, string> = { terminal_result: "正常结果收尾", pi_rpc_failure: "RPC 失败",
  output_capture_failure: "输出采集失败", runtime_exception: "执行异常", transport_cleanup: "连接清理",
  terminal_close: "终端关闭", unspecified_host: "宿主未细分来源" };

export function RuntimeProcessEvidenceView({ rows }: { rows?: RuntimeProcessEvidence[] }) {
  if (!rows?.length) return null;
  return <details className="mt-3 text-[12px] text-zinc-400">
    <summary>进程退出与清理证据（{rows.length}）</summary>
    <p className="my-2">连接中断后的执行结果需结合清理证据核对。没有合法断点时，自动恢复整个任务尚未交付。</p>
    {rows.map(row => <div key={row.audit_id} className="my-2 space-y-1 break-all">
      <p>{TERMINATIONS[row.observation.termination] ?? row.observation.termination}
        {row.observation.exit_code !== null ? `，退出码 ${row.observation.exit_code}` : "，退出码未知"}</p>
      {row.observation.host_kill_caller && <p>宿主结束来源 {CALLERS[row.observation.host_kill_caller] ?? "未细分"}，内存耗尽原因未核实。</p>}
      <p>PTY 清理 {OUTCOMES[row.observation.cleanup?.outcome ?? ""] ?? "无确认记录"}
        {row.observation.cleanup?.http_status ? `（HTTP ${row.observation.cleanup.http_status}）` : ""}</p>
      <p>沙箱销毁 {OUTCOMES[row.sandbox_cleanup?.outcome ?? ""] ?? "尚无确认记录"}</p>
      <p>Attempt {row.observation.attempt_id} · Sandbox {row.observation.sandbox_id} · Process {row.observation.process_id ?? "未知"}</p>
      <p>记录时间 {row.observed_at}</p>
    </div>)}
  </details>;
}
