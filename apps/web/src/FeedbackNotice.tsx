import type { ToastAction, ToastKind } from "./toast-model";
import { toastAria, toastKindLabel } from "./toast-model";

export function FeedbackNotice({ message, kind, onDismiss, action }: {
  message: string | null;
  kind: ToastKind;
  onDismiss?: () => void;
  action?: ToastAction;
}) {
  if (!message) return null;
  const aria = toastAria(kind);
  return <div className={`app-feedback is-${kind}`} role={aria.role} aria-live={aria.live} aria-atomic="true">
    <div className="app-feedback-content"><strong>{toastKindLabel(kind)}</strong><span>{message}</span></div>
    <div className="app-toast-controls">
      {action && <button type="button" className="app-toast-control is-action" onClick={action.onClick}>{action.label}</button>}
      {onDismiss && <button type="button" className="app-toast-control" aria-label="关闭提示" onClick={onDismiss}>×</button>}
    </div>
  </div>;
}
