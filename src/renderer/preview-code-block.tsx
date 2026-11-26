import { useEffect, useId, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { renderMermaidImage } from '../core/plugins/mermaid.ts';

interface PreviewCodeBlockProps extends ComponentProps<'pre'> {
  readonly language?: string;
  readonly code: string;
  readonly diagram?: string;
  readonly diagramLimited: boolean;
  readonly actions?: ReactNode;
}

export function PreviewCodeBlock({ language, code, diagram, diagramLimited, actions, children, ...props }: PreviewCodeBlockProps) {
  const blockId = useId();
  const modalTitleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [folded, setFolded] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [resolved, setResolved] = useState<{ source: string; url?: string }>();
  useEffect(() => {
    if (!diagram) return;
    let active = true;
    const timer = setTimeout(() => {
      void renderMermaidImage(diagram).then(url => {
        if (active) setResolved({ source: diagram, url });
      }, () => {
        if (active) setResolved({ source: diagram });
      });
    }, 160);
    return () => { active = false; clearTimeout(timer); };
  }, [diagram]);
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(''), 2400);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  const result = resolved?.source === diagram ? resolved : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus('已复制');
    } catch {
      setCopyStatus('复制失败');
    }
  };
  return <figure className="preview-code-card">
    <figcaption className="preview-code-header">
      <span>{language ?? '代码'}</span>
      <button type="button" onClick={() => void copy()}>{diagram ? '复制图表源码' : '复制代码'}</button>
      <span className="preview-copy-status" role="status">{copyStatus}</span>
      {result?.url && <button type="button" onClick={() => dialog.current?.showModal()}>放大图表</button>}
      <button type="button" aria-expanded={!folded} aria-controls={blockId} onClick={() => setFolded(value => !value)}>
        {folded ? '展开' : '折叠'}
      </button>
    </figcaption>
    <div id={blockId} hidden={folded}>
      {result?.url ? <img className="mermaid-diagram" src={result.url} alt="Mermaid 图表" /> : <>
        {(result || diagramLimited) && <small className="preview-note">
          {diagramLimited ? '已达到当前预览的图表数量上限。' : 'Mermaid 图表无法渲染，已显示源码。'}
        </small>}
        <pre {...props}>{children}</pre>
      </>}
      {actions}
    </div>
    {result?.url && <dialog ref={dialog} className="preview-diagram-dialog" aria-labelledby={modalTitleId}>
      <header>
        <strong id={modalTitleId}>Mermaid 图表</strong>
        <button type="button" onClick={() => dialog.current?.close()}>关闭</button>
      </header>
      <div className="preview-diagram-image" tabIndex={0}>
        <img src={result.url} alt="放大的 Mermaid 图表" />
      </div>
    </dialog>}
  </figure>;
}
