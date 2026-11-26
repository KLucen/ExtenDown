import { useEffect, useRef, useState } from 'react';
import type { UniformLineEnding } from './document-session';

const formats = [
  { value: 'lf', label: 'LF', description: '跨平台常用格式' },
  { value: 'crlf', label: 'CRLF', description: 'Windows 常用格式' },
] as const;

export function LineEndingDialog({ desktop, onClose, onConvert }: {
  desktop: boolean;
  onClose: () => void;
  onConvert: (lineEnding: UniformLineEnding) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [lineEnding, setLineEnding] = useState<UniformLineEnding>('lf');
  useEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog className="settings-modal line-ending-dialog" aria-labelledby="line-ending-title"
    aria-describedby="line-ending-description" ref={dialog} onClose={onClose}>
    <header className="modal-head"><h2 id="line-ending-title">统一换行</h2></header>
    <form className="settings-section" onSubmit={event => {
      event.preventDefault();
      dialog.current?.close();
      onConvert(lineEnding);
    }}>
      <p id="line-ending-description">这份文档混用了 LF、CRLF 或 CR 换行符。统一换行后即可编辑。
        {desktop ? '保存时才会写入原文件。' : '可下载转换后的副本。'}</p>
      <fieldset className="line-ending-options">
        <legend>换行格式</legend>
        {formats.map(format => <label key={format.value}>
          <input type="radio" name="line-ending" value={format.value} checked={lineEnding === format.value}
            onChange={() => setLineEnding(format.value)} />
          <strong>{format.label}</strong><small>{format.description}</small>
        </label>)}
      </fieldset>
      <div className="dialog-actions">
        <button className="setting-action" type="button" onClick={() => dialog.current?.close()}>取消</button>
        <button className="setting-action" type="submit">统一换行并编辑</button>
      </div>
    </form>
  </dialog>;
}
