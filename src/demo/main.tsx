import { history, historyKeymap } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { StrictMode, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { editorSelectionPosition, editorToMarkdownText, markdownToEditorText } from '../core/editor-text';
import { decodeMarkdownBytes, encodeMarkdownBytes } from '../core/markdown-source';
import type { MarkdownSourceFormat } from '../core/markdown-source';
import { MarkdownPreview } from '../renderer/markdown-preview';
import { SourceSurface } from '../renderer/source-surface';
import type { SourceSelection, SourceSurfaceHandle } from '../renderer/source-surface';
import './style.css';

type ViewMode = 'source' | 'split' | 'preview';

interface DocumentView {
  readonly key: number;
  readonly name: string;
  readonly original: string;
  readonly initialSource: string;
  readonly format: MarkdownSourceFormat;
}

const MODES: ReadonlyArray<{ value: ViewMode; label: string }> = [
  { value: 'source', label: '源码' },
  { value: 'split', label: '并排' },
  { value: 'preview', label: '预览' },
];

const STARTER_TEXT = [
  '# 写下你的想法',
  '',
  '在左栏编辑 **Markdown**，右栏用同一份文字排版。',
  '',
  '## 一份可反复修改的草稿',
  '',
  '> 好的笔记能让下次回顾更容易。',
  '',
  '- [x] 写下要点',
  '- [ ] 补上例子',
  '',
  '| 内容 | 进度 |',
  '| --- | --- |',
  '| 中文与 Emoji 🌿 | 已就绪 |',
  '| 图表和代码 | 可继续编辑 |',
  '',
  '```text',
  'write → read → revise',
  '```',
  '',
].join('\n');

const EXAMPLE: DocumentView = {
  key: 0,
  name: '示例.md',
  original: STARTER_TEXT,
  initialSource: STARTER_TEXT,
  format: { bomByteLength: 0, lineEnding: 'lf', hasTrailingLineEnding: true },
};

const START_SELECTION: SourceSelection = { start: 0, end: 0, direction: 'none' };
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function SourcePane({
  documentView,
  source,
  hidden,
  surface,
  onChange,
  onSelect,
  onCompositionChange,
}: {
  readonly documentView: DocumentView;
  readonly source: string;
  readonly hidden: boolean;
  readonly surface: RefObject<SourceSurfaceHandle | null>;
  readonly onChange: (value: string, selection: SourceSelection) => void;
  readonly onSelect: (selection: SourceSelection) => void;
  readonly onCompositionChange: (active: boolean) => void;
}) {
  const pane = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = pane.current;
    const editor = host && EditorView.findFromDOM(host);
    if (!editor) throw new Error('源码编辑区未初始化。');
    // MerMarkd delegates history to its document owner. The demo owner uses
    // CodeMirror history and recreates it only when the document key changes.
    editor.dispatch({ effects: StateEffect.appendConfig.of([history(), keymap.of(historyKeymap)]) });
  }, [documentView.key]);

  return (
    <section className="pane source-pane" aria-label="源码编辑" hidden={hidden} ref={pane}>
      <div className="pane-label">Markdown 源码</div>
      <SourceSurface
        ref={surface}
        documentKey={String(documentView.key)}
        documentName={documentView.name}
        value={source}
        readOnly={documentView.format.lineEnding === 'mixed'}
        softWrap
        onChange={onChange}
        onSelect={onSelect}
        onActivityChange={(_, active) => onCompositionChange(active)}
        onKeyDown={() => undefined}
        onContextMenu={() => undefined}
      />
    </section>
  );
}

function downloadMarkdown(name: string, bytes: Uint8Array): void {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Let Chromium finish consuming the Blob URL before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function App() {
  const [documentView, setDocumentView] = useState<DocumentView>(EXAMPLE);
  const [source, setSource] = useState(EXAMPLE.initialSource);
  const [mode, setMode] = useState<ViewMode>('split');
  const [selection, setSelection] = useState(START_SELECTION);
  const [composing, setComposing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const surface = useRef<SourceSurfaceHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingOpen = useRef(false);

  const dirty = source !== documentView.initialSource;
  const mixed = documentView.format.lineEnding === 'mixed';
  const previewInput = useMemo(() => ({ key: documentView.key, source }), [documentView.key, source]);
  const deferredPreview = useDeferredValue(previewInput);
  const previewSource = deferredPreview.key === previewInput.key ? deferredPreview.source : source;
  const cursor = useMemo(
    () => editorSelectionPosition(source, selection.start, selection.end),
    [source, selection.start, selection.end],
  );

  useEffect(() => {
    if (!dirty && !composing) return;
    function protectDraft(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [dirty, composing]);

  function canLeaveInput(): boolean {
    if (!surface.current?.composing()) return true;
    setNotice('请先完成输入法候选，再继续操作。');
    return false;
  }

  function changeMode(next: ViewMode): void {
    if (canLeaveInput()) setMode(next);
  }

  async function openFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || pendingOpen.current || !canLeaveInput()) return;
    pendingOpen.current = true;
    setOpening(true);
    setNotice('');
    setError('');
    try {
      if (!/\.(?:md|markdown)$/iu.test(file.name)) throw new Error('请选择 .md 或 .markdown 文档。');
      if (file.size > MAX_FILE_BYTES) throw new Error('此示例最多打开 2 MiB 的 Markdown 文档。');
      const opened = decodeMarkdownBytes(new Uint8Array(await file.arrayBuffer()));
      if (!canLeaveInput()) return;
      const current = surface.current?.text() ?? source;
      if (current !== documentView.initialSource && !window.confirm('当前正文有修改。要放弃修改并打开选中的文档吗？')) return;
      const nextSource = markdownToEditorText(opened.content);
      setDocumentView({
        key: documentView.key + 1,
        name: file.name,
        original: opened.content,
        initialSource: nextSource,
        format: opened.format,
      });
      setSource(nextSource);
      setSelection(START_SELECTION);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法读取 Markdown 文档。');
    } finally {
      pendingOpen.current = false;
      setOpening(false);
    }
  }

  function saveCopy(): void {
    if (!canLeaveInput()) return;
    setError('');
    try {
      const current = surface.current?.text() ?? source;
      const ending = documentView.format.lineEnding;
      // A mixed-format document never becomes editable in this demo. An
      // unchanged document is exported using its original text and BOM.
      const content = ending === 'mixed' || current === documentView.initialSource
        ? documentView.original
        : editorToMarkdownText(current, ending);
      const filename = documentView.name.replace(/\.(?:md|markdown)$/iu, '') + ' - 副本.md';
      downloadMarkdown(filename, encodeMarkdownBytes(content, documentView.format.bomByteLength));
      setNotice('已请求下载 Markdown 副本。');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法生成 Markdown 副本。');
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">墨</span>
          <h1>ExtenDown</h1>
        </div>
        <div className="modes" role="group" aria-label="编辑视图">
          {MODES.map(({ value, label }) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => changeMode(value)}>{label}</button>
          ))}
        </div>
        <div className="file-actions">
          <input ref={fileInput} type="file" accept=".md,.markdown,text/markdown" onChange={openFile} hidden />
          <button type="button" onClick={() => { if (canLeaveInput()) fileInput.current?.click(); }} disabled={opening}>
            {opening ? '正在打开…' : '打开文件'}
          </button>
          <button className="primary" type="button" onClick={saveCopy}>下载副本</button>
        </div>
      </header>

      <main className="document">
        <div className="document-bar">
          <span className="document-name" title={documentView.name}>{documentView.name}</span>
          {dirty && <span className="dirty">有修改</span>}
          {mixed && <span className="dirty">混合换行 · 只读</span>}
          {!!notice && <span className="notice" role="status">{notice}</span>}
          {!!error && <span className="error" role="alert">{error}</span>}
        </div>
        <div className="workspace" data-mode={mode}>
          <SourcePane
            documentView={documentView}
            source={source}
            hidden={mode === 'preview'}
            surface={surface}
            onChange={(value, next) => { setSource(value); setSelection(next); }}
            onSelect={setSelection}
            onCompositionChange={setComposing}
          />
          {mode !== 'source' && (
            <section className="pane preview-pane" aria-label="排版预览">
              <div className="pane-label">排版预览</div>
              <div className="reading-scroll" tabIndex={0}>
                <MarkdownPreview key={documentView.key} source={previewSource} />
              </div>
            </section>
          )}
        </div>
        <footer className="statusbar">
          <span>行 {cursor.line}，列 {cursor.column}</span>
          <span>UTF-8{documentView.format.bomByteLength === 3 ? ' BOM' : ''} · {
            documentView.format.lineEnding === 'none' ? '单行' : documentView.format.lineEnding.toUpperCase()
          }</span>
        </footer>
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('页面容器未找到。');
createRoot(root).render(<StrictMode><App /></StrictMode>);
