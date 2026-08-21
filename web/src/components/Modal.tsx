import { X } from "lucide-react";
import { useEffect, useRef, type FormEventHandler, type ReactNode } from "react";

/**
 * 对话框外壳：统一负责 Escape 关闭、焦点圈禁、关闭后焦点还原与 role="dialog"。
 * 表单字段与底部按钮由调用方通过 children 提供，onSubmit 由调用方传入。
 */
export function Modal({ eyebrow, title, onClose, onSubmit, children }: {
  eyebrow?: string;
  title: string;
  onClose: () => void;
  onSubmit?: FormEventHandler;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  // 用 ref 持有最新回调，避免 onClose 身份变化导致焦点被重复抢走
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const node = dialogRef.current;
    // 记录打开前的焦点元素，关闭后还原到触发按钮
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !node) return;
      // 焦点圈禁：Tab / Shift+Tab 始终在对话框内循环
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(
        "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex=\"-1\"])",
      ));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop">
      <form className="modal" role="dialog" aria-modal="true" aria-label={title} ref={dialogRef} tabIndex={-1} onSubmit={onSubmit}>
        <div className="modal-head">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={() => onCloseRef.current()} aria-label="关闭"><X aria-hidden="true" /></button>
        </div>
        {children}
      </form>
    </div>
  );
}

/** 破坏性/不可逆操作的二次确认对话框：确认后才执行，请求期间按钮禁用。 */
export function ConfirmDialog({ title, description, confirmLabel, busy = false, onConfirm, onClose }: {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} onSubmit={(event) => { event.preventDefault(); if (!busy) onConfirm(); }}>
      <p className="confirm-description">{description}</p>
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="danger" disabled={busy}>{busy ? "处理中…" : confirmLabel}</button>
      </div>
    </Modal>
  );
}
