import { useEffect, useRef } from 'react';

export function CloseDraftDialog({ onClose, onConfirm }: {
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, []);

  return <dialog className="settings-modal close-draft-dialog" ref={dialog}
    aria-labelledby="close-draft-title" aria-describedby="close-draft-description"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="modal-head">
      <h2 id="close-draft-title">关闭窗口</h2>
      <button type="button" aria-label="取消关闭" onClick={onClose}>×</button>
    </header>
    <div className="settings-section">
      <p id="close-draft-description">关闭窗口并保留恢复草稿？</p>
      <div className="close-draft-actions">
        <button ref={cancel} type="button" className="setting-action" onClick={onClose}>取消</button>
        <button type="button" className="close-draft-confirm" onClick={onConfirm}>关闭并保留草稿</button>
      </div>
    </div>
  </dialog>;
}
