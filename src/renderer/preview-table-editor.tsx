import { useEffect, useId, useRef, useState } from 'react';
import {
  buildPreviewTablePatch, MAX_TABLE_EDITOR_COLUMNS, MAX_TABLE_EDITOR_ROWS,
  type EditablePreviewTable, type PreviewSourcePatch, type PreviewTableAlignment, type PreviewTableDraft,
} from '../core/preview-edit.ts';

export function PreviewTableEditor({ table, onApply, onClose, onDraftChange, onCompositionChange }: {
  readonly table: EditablePreviewTable;
  readonly onApply: (patch: PreviewSourcePatch) => boolean;
  readonly onClose: () => void;
  readonly onDraftChange: (active: boolean) => void;
  readonly onCompositionChange: (active: boolean) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const composing = useRef(false);
  const [draft, setDraft] = useState<PreviewTableDraft>(table.draft);
  const [message, setMessage] = useState('');
  const change = (next: PreviewTableDraft) => {
    setDraft(next);
    setMessage('');
    onDraftChange(JSON.stringify(table.draft) !== JSON.stringify(next));
  };

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const close = () => {
    if (composing.current) return;
    onDraftChange(false);
    onClose();
  };
  const apply = () => {
    if (composing.current) return;
    const patch = buildPreviewTablePatch(table, draft);
    if (!patch) {
      setMessage('请检查表格语法。单元格内的竖线需要写成 \\|。');
      return;
    }
    if (onApply(patch)) close();
    else setMessage('源文档已更新。可复制这里的修改，再打开最新的表格。');
  };
  const updateCell = (rowIndex: number, columnIndex: number, cell: string) => {
    change({ ...draft, rows: draft.rows.map((row, index) => index === rowIndex
      ? row.map((value, column) => column === columnIndex ? cell : value) : row) });
  };
  const updateAlignment = (columnIndex: number, alignment: PreviewTableAlignment) => {
    change({ ...draft, alignments: draft.alignments.map((value, column) => column === columnIndex ? alignment : value) });
  };
  const addRow = () => change({ ...draft, rows: [...draft.rows, draft.alignments.map(() => '')] });
  const addColumn = () => change({ rows: draft.rows.map(row => [...row, '']), alignments: [...draft.alignments, null] });
  const deleteRow = (index: number) => change({ ...draft, rows: draft.rows.filter((_, row) => row !== index) });
  const deleteColumn = (index: number) => change({
    rows: draft.rows.map(row => row.filter((_, column) => column !== index)),
    alignments: draft.alignments.filter((_, column) => column !== index),
  });

  return <dialog ref={dialog} className="preview-table-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}
    onCompositionStart={() => { composing.current = true; onCompositionChange(true); }}
    onCompositionEnd={() => { composing.current = false; onCompositionChange(false); }}>
    <h2 id={titleId}>编辑表格</h2>
    <p className="preview-note">单元格支持 Markdown，使用 \| 输入竖线。</p>
    <div className="preview-table-grid">
      <table>
        <thead><tr>
          <th scope="col">列对齐</th>
          {draft.alignments.map((alignment, column) => <th scope="col" key={column}>
            <select aria-label={'第 ' + (column + 1) + ' 列对齐'} value={alignment ?? ''}
              onChange={event => updateAlignment(column, (event.target.value || null) as PreviewTableAlignment)}>
              <option value="">默认</option><option value="left">左对齐</option>
              <option value="center">居中</option><option value="right">右对齐</option>
            </select>
            <button type="button" disabled={draft.alignments.length <= 1} onClick={() => deleteColumn(column)}
              aria-label={'删除第 ' + (column + 1) + ' 列'}>删列</button>
          </th>)}
        </tr></thead>
        <tbody>{draft.rows.map((row, index) => <tr key={index}>
          <th scope="row">{index === 0 ? '表头' : <button type="button" onClick={() => deleteRow(index)} aria-label={'删除第 ' + index + ' 行'}>删行</button>}</th>
          {row.map((value, column) => <td key={column}>
            <input type="text" value={value} autoFocus={index === 0 && column === 0}
              aria-label={(index === 0 ? '表头' : '第 ' + index + ' 行') + '第 ' + (column + 1) + ' 列'}
              onChange={event => updateCell(index, column, event.target.value)} />
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    {message && <p role="status" className="preview-note">{message}</p>}
    <div className="preview-table-actions">
      <button type="button" disabled={draft.rows.length >= MAX_TABLE_EDITOR_ROWS} onClick={addRow}>添加行</button>
      <button type="button" disabled={draft.alignments.length >= MAX_TABLE_EDITOR_COLUMNS} onClick={addColumn}>添加列</button>
      <button type="button" onClick={close}>取消</button>
      <button type="button" onClick={apply}>应用</button>
    </div>
  </dialog>;
}
