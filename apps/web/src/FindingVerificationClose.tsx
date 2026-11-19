import { useEffect, useRef, useState } from "react";
import type { FindingInconclusiveBody, FindingVerificationControl } from "@deepsonar/shared-types";
import { api } from "./api";
import { canAccessAnyScope } from "./permissions";
import { ApiRequestError } from "./login-error";
import { useConfirmDialog } from "./components/ConfirmDialog";

export function FindingVerificationClose({ findingId, control, onChanged }: {
  findingId: string;
  control: FindingVerificationControl;
  onChanged: () => Promise<unknown>;
}) {
  const scope = JSON.stringify([findingId, control.verify_status, control.subject_revision, control.latest_round_id]);
  return <ScopedVerificationClose key={scope} findingId={findingId} control={control} onChanged={onChanged} />;
}

function ScopedVerificationClose({ findingId, control, onChanged }: {
  findingId: string;
  control: FindingVerificationControl;
  onChanged: () => Promise<unknown>;
}) {
  const confirm = useConfirmDialog();
  const [allowed, setAllowed] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<FindingInconclusiveBody | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    let alive = true;
    active.current = true;
    setAllowed(false);
    api.authMe().then((me) => alive && setAllowed(canAccessAnyScope(me, ["findings:write"]))).catch(() => {});
    return () => { alive = false; active.current = false; };
  }, [findingId]);
  if (!allowed || control.verify_status !== "needs_human") return null;

  const close = async () => {
    if (!reason.trim() || inFlight.current || !active.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // getRandomValues 也可用于普通 HTTP。生成失败仍由 finally 释放按钮。
      let body = pending.current;
      if (!body) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        const mutationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        // 传输失败后保留同一编号和原始决定，先核对原请求结果。
        body = { verify_status: "inconclusive", reason: reason.trim(), expected: control, mutation_id: mutationId };
      }
      const confirmed = await confirm({
        title: "以无定论结束技术验证？",
        description: "这会记录你的原因并新增一条无定论验证记录，结束本次证据不足的技术验证。",
        confirmLabel: "以无定论结束",
      });
      if (!confirmed || !active.current) return;
      pending.current = body;
      await api.closeFindingInconclusive(findingId, body);
      if (!active.current) return;
      pending.current = null;
      await onChanged();
    } catch (failure) {
      if (!active.current) return;
      if (failure instanceof ApiRequestError && failure.status === 409) {
        pending.current = null;
        await onChanged();
      }
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  return <section className="mt-3 space-y-2" aria-label="人工结束技术验证">
    <label className="block text-[12px] text-zinc-400">
      无定论原因（必填）
      <textarea value={reason} maxLength={2000} rows={3} disabled={busy || pending.current !== null}
        onChange={(event) => setReason(event.target.value)}
        className="theme-input-surface mt-1 w-full rounded-lg border px-2.5 py-1.5" />
    </label>
    <button type="button" disabled={busy || !reason.trim()} onClick={() => void close()}
      className="theme-surface w-full rounded-lg px-3 py-2 text-[12px] text-amber-300 ring-1 disabled:opacity-40">
      {busy ? "保存中…" : "以无定论结束"}
    </button>
    {error && <p role="alert" className="text-[12px] text-red-300">{error}</p>}
  </section>;
}
