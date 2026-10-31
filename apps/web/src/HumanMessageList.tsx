import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { CanvasHumanMessage } from "./api";
import { humanMessageStatusLabel, toggleExpandedId } from "./human-messages";

export function HumanMessageList({
  messages,
  heading,
  expandedIds,
  onExpandedIdsChange,
}: {
  messages: readonly CanvasHumanMessage[];
  heading: string;
  expandedIds: readonly string[];
  onExpandedIdsChange: (ids: string[]) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <section className="human-message-detail-section mb-3" aria-label={heading}>
      <div className="human-message-detail-heading"><span>{heading}</span><strong>{messages.length}</strong></div>
      <ol>
        {messages.map((message) => {
          const expanded = expandedIds.includes(message.id);
          return (
            <li key={message.id} className={expanded ? "is-expanded" : "is-collapsed"}>
              <button
                type="button"
                className="human-message-detail-toggle"
                aria-expanded={expanded}
                onClick={() => onExpandedIdsChange(toggleExpandedId(expandedIds, message.id))}
              >
                {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
                <div className="human-message-detail-meta">
                  <strong>{humanMessageStatusLabel(message.status)}</strong>
                  <span>{new Date(message.planned_at).toLocaleString()}</span>
                </div>
              </button>
              <p className={expanded ? undefined : "is-preview"}>{message.body}</p>
              {expanded && message.attachments.length > 0 && (
                <ul>
                  {message.attachments.map((attachment) => (
                    <li key={attachment.version_id}>
                      {attachment.filename ?? attachment.logical_key ?? attachment.version_id}
                      <small>{attachment.bytes.toLocaleString()} bytes · {attachment.content_type ?? attachment.content_sha256.slice(0, 12)}</small>
                    </li>
                  ))}
                </ul>
              )}
              {expanded && message.delivered_at && <small>投递：{new Date(message.delivered_at).toLocaleString()}</small>}
              {expanded && message.acknowledged_at && <small>ACK：{new Date(message.acknowledged_at).toLocaleString()}{message.ack_summary ? ` · ${message.ack_summary}` : ""}</small>}
              {expanded && message.error && <small className="is-error">{message.error}</small>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
