import { CheckCircle, File, PaperPlaneTilt, UploadSimple, X } from "@phosphor-icons/react";
import { useId, useMemo, useRef, useState } from "react";
import { api, type CanvasHumanMessage, type CanvasNode } from "./api";
import {
  HUMAN_MESSAGE_MAX_LENGTH,
  humanMessageAssetKey,
  humanMessageTargetForNode,
  isReplyableHumanMessageTarget,
  type HumanMessageJobRef,
} from "./human-messages";

const MAX_ATTACHMENTS = 20;

export function HumanMessageComposer({
  canvasId,
  projectId,
  selectedNode,
  jobs,
  onClose,
  onSent,
}: {
  canvasId: string;
  projectId: string | null;
  selectedNode: CanvasNode | null;
  jobs?: readonly HumanMessageJobRef[];
  onClose: () => void;
  onSent: (message: CanvasHumanMessage) => void;
}) {
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const nodeEligible = isReplyableHumanMessageTarget(selectedNode, jobs);
  const [targetKind, setTargetKind] = useState<"hub" | "job" | null>(nodeEligible ? "job" : null);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const trimmed = body.trim();
  const jobTarget = nodeEligible ? humanMessageTargetForNode(selectedNode, jobs) : null;
  const target = targetKind === "job" ? jobTarget : targetKind === "hub" ? { kind: "hub" as const } : null;
  const canSubmit = Boolean(projectId && target && trimmed.length >= 1 && trimmed.length <= HUMAN_MESSAGE_MAX_LENGTH && !busy);
  const targetTitle = target?.kind === "hub" ? "Hub" : target?.kind === "job" ? selectedNode?.title ?? "当前运行" : "未选择";
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setError("");
    setFiles((current) => [...current, ...Array.from(incoming)].slice(0, MAX_ATTACHMENTS));
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = async () => {
    if (!canSubmit || !projectId || !target) return;
    const messageId = crypto.randomUUID();
    setBusy(true);
    setError("");
    setProgress(files.length ? `正在上传 0 / ${files.length} 个附件` : "正在建立消息账本");
    const versionIds: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      try {
        const file = files[index];
        const asset = await api.uploadProjectSharedAsset(
          projectId,
          file,
          humanMessageAssetKey(messageId, file.name, index),
          { purpose: "human-message", message_id: messageId },
        );
        versionIds.push(asset.version_id);
        setProgress(`正在上传 ${index + 1} / ${files.length} 个附件`);
      } catch (cause) {
        setError(`附件上传失败（${index + 1}/${files.length}）：${cause instanceof Error ? cause.message : String(cause)}。消息未发送；已上传的资产仍保留在项目共享资产中。`);
        setProgress("");
        setBusy(false);
        return;
      }
    }
    try {
      setProgress("附件完整，正在发送消息");
      const created = await api.createCanvasMessage(canvasId, {
        message_id: messageId,
        target,
        body: trimmed,
        attachment_version_ids: versionIds,
      });
      onSent({ ...created, status: created.status ?? created.delivery_status ?? "planned", attachments: created.attachments ?? [] });
    } catch (cause) {
      setError(`消息发送失败：${cause instanceof Error ? cause.message : String(cause)}。系统不会自动重发；请确认目标状态后手动重新发送。`);
      setProgress("");
      setBusy(false);
    }
  };

  return (
    <div className="theme-overlay human-message-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="theme-drawer human-message-composer" role="dialog" aria-modal="true" aria-labelledby={`${inputId}-title`}>
        <header>
          <div>
            <span>HUMAN → RUNTIME</span>
            <h2 id={`${inputId}-title`}>发送人工消息</h2>
            <p>文字和附件将写入独立投递账本；只有 Agent 主动 ACK 后才显示“Agent 已确认”。</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭发消息面板"><X size={17} /></button>
        </header>

        <div className="human-message-composer-body">
          <fieldset disabled={busy}>
            <legend>发送目标</legend>
            {!nodeEligible && (
              <p className="human-message-target-hint">当前上下文没有可投递的活动 intent / job / report。human 节点不能投递；若要发给 Hub，请显式选择。</p>
            )}
            <label className={targetKind === "hub" ? "is-selected" : ""}>
              <input type="radio" name={`${inputId}-target`} checked={targetKind === "hub"} onChange={() => setTargetKind("hub")} />
              <span><strong>Hub</strong><small>发送给当前任务的活跃 Hub；没有活跃 Hub 时由系统唤醒</small></span>
            </label>
            <label className={`${targetKind === "job" ? "is-selected" : ""} ${nodeEligible ? "" : "is-disabled"}`}>
              <input type="radio" name={`${inputId}-target`} checked={targetKind === "job"} disabled={!nodeEligible} onChange={() => setTargetKind("job")} />
              <span><strong>{nodeEligible ? selectedNode.title : "当前选中的运行节点"}</strong><small>{nodeEligible ? `${selectedNode.node_type} · ${selectedNode.status} · 直接投递此运行会话` : "仅活动运行或 Job 仍为 waiting_human 的 intent / job / report 可发送"}</small></span>
            </label>
          </fieldset>

          <label className="human-message-body-field" htmlFor={`${inputId}-body`}>
            <span><strong>消息正文</strong><small className={trimmed.length > HUMAN_MESSAGE_MAX_LENGTH ? "is-error" : ""}>{body.length} / {HUMAN_MESSAGE_MAX_LENGTH}</small></span>
            <textarea id={`${inputId}-body`} value={body} disabled={busy} maxLength={HUMAN_MESSAGE_MAX_LENGTH} rows={8} onChange={(event) => setBody(event.target.value)} placeholder={`写给 ${targetTitle} 的明确上下文、要求或更正…`} />
          </label>

          <div className="human-message-files">
            <div><strong>附件</strong><small>{files.length} / {MAX_ATTACHMENTS}{files.length ? ` · ${totalBytes.toLocaleString()} bytes` : ""}</small></div>
            <input ref={fileRef} type="file" multiple disabled={busy || files.length >= MAX_ATTACHMENTS} onChange={(event) => addFiles(event.target.files)} aria-label="选择消息附件" />
            <button type="button" disabled={busy || files.length >= MAX_ATTACHMENTS} onClick={() => fileRef.current?.click()}><UploadSimple size={15} /> 选择文件</button>
            {files.length > 0 && <ul>{files.map((file, index) => <li key={`${file.name}:${file.lastModified}:${index}`}><File size={14} /><span><strong>{file.name}</strong><small>{file.size.toLocaleString()} bytes · {file.type || "未知类型"}</small></span><button type="button" disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}><X size={13} /></button></li>)}</ul>}
            <p>附件会先作为项目共享资产完整上传，再一次性引用；任一上传失败都不会发送残缺消息。</p>
          </div>

          {error && <div className="human-message-feedback is-error" role="alert">{error}</div>}
          {progress && <div className="human-message-feedback" aria-live="polite"><CheckCircle size={14} /> {progress}</div>}
        </div>

        <footer>
          <span>发送后不静默重试 · 目标 {targetTitle}</span>
          <div><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="is-primary" disabled={!canSubmit} onClick={() => void submit()}><PaperPlaneTilt size={15} /> {busy ? "发送中…" : "发送消息"}</button></div>
        </footer>
      </section>
    </div>
  );
}
