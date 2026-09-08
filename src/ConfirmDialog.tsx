import { Icon } from "./icons";

export function ConfirmDialog({ title, body, confirmLabel, busy = false, danger = false, onConfirm, onClose }: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return <dialog open className="modal" aria-labelledby="confirm-title">
    <div className="modal-scrim" onClick={onClose} />
    <div className="modal-card narrow">
      <header className="modal-header"><div><span className="eyebrow">ПОДТВЕРЖДЕНИЕ</span><h2 id="confirm-title">{title}</h2></div><button className="icon-button" onClick={onClose}><Icon name="close" /></button></header>
      <div className="confirm-body">{body}</div>
      <footer className="modal-footer"><button autoFocus className="button ghost" onClick={onClose}>Отмена</button><button className={`button${danger ? " danger-button" : ""}`} disabled={busy} onClick={onConfirm}>{busy ? "Подождите…" : confirmLabel}</button></footer>
    </div>
  </dialog>;
}
