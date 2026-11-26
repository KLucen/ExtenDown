import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  exportFilename, exportHtmlPage, prepareExportContent, saveExportArtifact,
  type DocumentSnapshot, type ExportContent, type ExportFormat, type ExportOptions,
} from '../core/export/index.ts';
import './export-dialog.css';

const FORMATS: readonly ExportFormat[] = ['html', 'pdf', 'png', 'jpg'];
const FORMAT_DESCRIPTIONS: Record<ExportFormat, string> = {
  html: '可在浏览器离线打开的网页。',
  pdf: '适合分享和打印的分页文档。',
  png: '保留细节的无损图片。',
  jpg: '体积较小的压缩图片。',
};

interface ExportDialogProps {
  readonly snapshot: DocumentSnapshot;
  readonly formats?: readonly ExportFormat[];
  readonly onClose: () => void;
  readonly onSaved: (result: string) => void;
}

export function ExportDialog({ snapshot, formats = FORMATS, onClose, onSaved }: ExportDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const formatHintId = useId();
  const previewTitleId = useId();
  const [selectedFormat, setFormat] = useState<ExportFormat>(formats[0] ?? 'html');
  const format = formats.includes(selectedFormat) ? selectedFormat : formats[0];
  const imageFormat = format === 'png' || format === 'jpg';
  const showTitle = format === 'html' || format === 'pdf';
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
  const filename = format && exportFilename(snapshot.name, format) + (imageFormat && splitImages ? '.zip' : '');
  const hasContent = Boolean(prepared?.body.trim());
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
    prepared && hasContent ? exportHtmlPage(prepared, { title, background }, true) : '',
  [prepared, hasContent, title, background]);

  function close() {
    ref.current?.close();
    onClose();
  }

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
        close();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : '无法导出文件。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="export-dialog" aria-labelledby={headingId}
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <form className="export-form" onSubmit={save}>
        <header className="export-header">
          <h2 id={headingId}>导出文档</h2>
          <button type="button" className="export-close" aria-label="关闭导出" disabled={busy} onClick={close}>×</button>
        </header>
        <div className="export-workspace">
          <div className="export-options">
            <fieldset className="export-format" disabled={busy} aria-describedby={formatHintId}>
              <legend>导出格式</legend>
              {format && <div className="export-format-choices">
                {formats.map(item => <label key={item}>
                  <input name="format" type="radio" value={item} checked={item === format} onChange={() => setFormat(item)} />
                  <span>{item.toUpperCase()}</span>
                </label>)}
              </div>}
              <p id={formatHintId}>{format ? FORMAT_DESCRIPTIONS[format] : '请在「设置 → 插件」启用导出组件。'}</p>
            </fieldset>
            {format && <fieldset className="export-fields" disabled={busy} aria-label="导出设置">
              {showTitle && <label className="export-field export-field-wide">文档标题
                <input value={title} placeholder={prepared?.title} maxLength={200} onChange={event => setTitle(event.target.value)} />
              </label>}
              <label className="export-field">背景颜色
                <span className="export-color">
                  <input type="color" value={background} onChange={event => setBackground(event.target.value)} />
                  <span aria-hidden="true">{background.toUpperCase()}</span>
                </span>
              </label>
              {format !== 'html' && <label className="export-field">清晰度
                <select value={scale} onChange={event => setScale(Number(event.target.value))}>
                  <option value={1}>标准 · 1×</option>
                  <option value={2}>高清 · 2×</option>
                </select>
              </label>}
              {format === 'pdf' && <>
                <label className="export-field">纸张
                  <select value={paper} onChange={event => setPaper(event.target.value as typeof paper)}>
                    <option value="a4">A4</option>
                    <option value="letter">Letter</option>
                  </select>
                </label>
                <label className="export-field">方向
                  <select value={orientation} onChange={event => setOrientation(event.target.value as typeof orientation)}>
                    <option value="portrait">纵向</option>
                    <option value="landscape">横向</option>
                  </select>
                </label>
                <label className="export-field">页边距（mm）
                  <input type="number" value={marginMm} min={5} max={35} required onChange={event => setMarginMm(Number(event.target.value))} />
                </label>
              </>}
              {imageFormat && <label className="export-checkbox export-field-wide">
                <input type="checkbox" checked={splitImages} onChange={event => setSplitImages(event.target.checked)} />
                分段图片（ZIP）
              </label>}
            </fieldset>}
          </div>
          <section className="export-preview" aria-labelledby={previewTitleId}>
            <div className="export-preview-heading">
              <h3 id={previewTitleId}>内容预览</h3>
              {format && format !== 'html' && <p>分页和尺寸以导出文件为准</p>}
            </div>
            <div className="export-paper">
              {preview ? <iframe className="export-frame" title="导出内容预览" sandbox="" srcDoc={preview} /> :
                <div className="export-preview-placeholder">
                  {prepared ? <p>当前文档没有可预览的内容</p> :
                    error ? <p>预览不可用</p> : <p role="status">正在准备预览…</p>}
                </div>}
            </div>
          </section>
        </div>
        {error && <p role="alert" className="export-error">{error}</p>}
        <footer className="export-footer">
          <span className="export-filename" title={filename || undefined}>{filename}</span>
          <div className="export-actions">
            <button type="button" className="export-cancel" disabled={busy} onClick={close}>取消</button>
            <button type="submit" className="export-submit" disabled={busy || !prepared || !format}>
              {busy ? '正在导出…' : format ? '导出 ' + format.toUpperCase() : '导出'}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
