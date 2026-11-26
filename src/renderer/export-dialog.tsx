import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  exportHtmlPage, prepareExportContent, saveExportArtifact,
  type DocumentSnapshot, type ExportContent, type ExportFormat, type ExportOptions,
} from '../core/export/index.ts';

const FORMATS: readonly ExportFormat[] = ['html', 'pdf', 'png', 'jpg'];

interface ExportDialogProps {
  readonly snapshot: DocumentSnapshot;
  readonly formats?: readonly ExportFormat[];
  readonly onClose: () => void;
  readonly onSaved: (result: string) => void;
}

export function ExportDialog({ snapshot, formats = FORMATS, onClose, onSaved }: ExportDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [selectedFormat, setFormat] = useState<ExportFormat>(formats[0] ?? 'html');
  const format = formats.includes(selectedFormat) ? selectedFormat : formats[0];
  const [title, setTitle] = useState('');
  const [background, setBackground] = useState('#ffffff');
  const [scale, setScale] = useState(2);
  const [paper, setPaper] = useState<NonNullable<ExportOptions['paper']>>('a4');
  const [orientation, setOrientation] = useState<NonNullable<ExportOptions['orientation']>>('portrait');
  const [marginMm, setMarginMm] = useState(12);
  const [splitImages, setSplitImages] = useState(false);
  const [preparation, setPreparation] = useState<{ snapshot: DocumentSnapshot; content: ExportContent } | null>(null);
  const prepared = preparation?.snapshot === snapshot ? preparation.content : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = { title, background, scale, paper, orientation, marginMm, splitImages };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    let active = true;
    setError('');
    void prepareExportContent(snapshot).then(
      content => { if (active) setPreparation({ snapshot, content }); },
      failure => { if (active) setError(failure instanceof Error ? failure.message : '无法准备导出内容。'); },
    );
    return () => { active = false; };
  }, [snapshot]);

  const preview = useMemo(() =>
    prepared ? exportHtmlPage(prepared, { title, background }, true) : '',
  [prepared, title, background]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prepared || busy || !format) return;
    setBusy(true);
    setError('');
    try {
      const artifact = format === 'html'
        ? (await import('../core/export/save-html-export.ts')).exportPreparedHtml(snapshot, prepared, options)
        : await (await import('../core/export/raster-export.ts')).exportRendered(format, snapshot, options, prepared);
      const result = await saveExportArtifact(artifact);
      if (result) {
        onSaved(result);
        onClose();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : '无法导出文件。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="export-dialog" aria-labelledby={headingId}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
      <form onSubmit={save}>
        <h2 id={headingId}>导出文档</h2>
        <div className="export-options">
          <label>格式 <select value={format ?? ''} disabled={busy || !format} onChange={event => setFormat(event.target.value as ExportFormat)}>
            {formats.map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}
          </select></label>
          <label>文档标题 <input value={title} disabled={busy} placeholder={prepared?.title}
            maxLength={200} onChange={event => setTitle(event.target.value)} /></label>
          <label>背景 <input type="color" value={background} disabled={busy}
            onChange={event => setBackground(event.target.value)} /></label>
          {format && format !== 'html' && (
            <label>清晰度 <select value={scale} disabled={busy} onChange={event => setScale(Number(event.target.value))}>
              <option value={1}>标准 · 1×</option>
              <option value={2}>高清 · 2×</option>
            </select></label>
          )}
          {(format === 'png' || format === 'jpg') && (
            <label><input type="checkbox" checked={splitImages} disabled={busy}
              onChange={event => setSplitImages(event.target.checked)} /> 分段图片（ZIP）</label>
          )}
          {format === 'pdf' && (
            <>
              <label>纸张 <select value={paper} disabled={busy} onChange={event => setPaper(event.target.value as typeof paper)}>
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
              </select></label>
              <label>方向 <select value={orientation} disabled={busy} onChange={event => setOrientation(event.target.value as typeof orientation)}>
                <option value="portrait">纵向</option>
                <option value="landscape">横向</option>
              </select></label>
              <label>页边距（mm） <input type="number" value={marginMm} min={5} max={35} required disabled={busy}
                onChange={event => setMarginMm(Number(event.target.value))} /></label>
            </>
          )}
        </div>
        {preview && <iframe className="export-frame" title="导出内容预览" sandbox="" srcDoc={preview} />}
        {!prepared && !error && <p role="status">正在准备预览…</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" disabled={busy || !prepared || !format}>
            {busy ? '正在导出…' : '导出'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
