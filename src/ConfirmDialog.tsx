import { Modal } from "./Ui";

export function ConfirmDialog({ title, body, confirmLabel, busy = false, danger = false, onConfirm, onClose }: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return <Modal
    title={title}
    eyebrow="CONFIRMATION"
    className="narrow"
    dirty={busy}
    onClose={onClose}
    footer={<><button data-autofocus className="button ghost" onClick={onClose}>Cancel</button><button className={`button${danger ? " danger-button" : ""}`} disabled={busy} onClick={onConfirm}>{busy ? "Please wait…" : confirmLabel}</button></>}
  >
    <div className="confirm-body">{body}</div>
  </Modal>;
}
