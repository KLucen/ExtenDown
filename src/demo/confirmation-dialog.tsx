import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './confirmation-dialog.css';

type ActionVariant = 'primary' | 'danger';

interface ConfirmationAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly variant?: ActionVariant;
}

interface ConfirmationDialogProps {
  readonly title: string;
  readonly description: ReactNode;
  readonly actions: readonly ConfirmationAction[];
  readonly onCancel: () => void;
  readonly busy?: boolean;
  readonly error?: string;
}

export function ConfirmationDialog({ title, description, actions, onCancel, busy = false, error }: ConfirmationDialogProps) {
  const headingId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    cancel.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  return <dialog ref={dialog} className="settings-modal confirmation-dialog" aria-labelledby={headingId}
    aria-describedby={descriptionId} aria-busy={busy || undefined}
    onCancel={event => {
      event.preventDefault();
      if (!busy) onCancel();
    }}>
    <header className="modal-head confirmation-header">
      <h2 id={headingId}>{title}</h2>
      <button type="button" onClick={onCancel} aria-label="取消确认" disabled={busy}>×</button>
    </header>
    <div className="confirmation-content" id={descriptionId}>{description}</div>
    {error && <p className="confirmation-error" role="alert">{error}</p>}
    <footer className="confirmation-actions">
      <button ref={cancel} type="button" onClick={onCancel} disabled={busy}>取消</button>
      {actions.map(action => <button type="button" key={action.label} data-variant={action.variant}
        onClick={action.onClick} disabled={busy}>{action.label}</button>)}
    </footer>
  </dialog>;
}

interface ConfirmationRequest {
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly variant?: ActionVariant;
}

export function useConfirmation() {
  const [request, setRequest] = useState<ConfirmationRequest | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => () => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(false);
  }, []);

  function confirm(next: ConfirmationRequest): Promise<boolean> {
    if (resolveRef.current) return Promise.resolve(false);
    return new Promise(resolve => {
      resolveRef.current = resolve;
      setRequest(next);
    });
  }

  function settle(confirmed: boolean) {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }

  return {
    confirm,
    open: request !== null,
    dialog: request && <ConfirmationDialog title={request.title} description={request.description}
      onCancel={() => settle(false)}
      actions={[{ label: request.confirmLabel, onClick: () => settle(true), variant: request.variant ?? 'primary' }]} />,
  };
}
