import { history, historyKeymap, redo, undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { StrictMode, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { editorSelectionPosition, findEditorTextMatches } from '../core/editor-text';
import type { DocumentSnapshot } from '../core/export';
import { buildSourceOutline } from '../core/source-outline';
import { ExportDialog } from '../renderer/export-dialog';
import { MarkdownPreview } from '../renderer/markdown-preview';
import { SourceSurface } from '../renderer/source-surface';
import type { SourceSurfaceHandle } from '../renderer/source-surface';
import { useDocument } from './document-session';
import { FirstRun, Settings, useExtensions } from './settings';
import './style.css';

type ViewMode = 'source' | 'split' | 'preview';
const MODES = [
  { value: 'source', label: '源码' },
  { value: 'split', label: '并排' },
  { value: 'preview', label: '预览' },
] as const;

function App() {
  const surface = useRef<SourceSurfaceHandle>(null);
  const sourcePane = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const session = useDocument(surface);
  const { view, source, selection, desktop, dirty, pending } = session;
  const plugins = useExtensions();
  const windowsChrome = desktop && /\bWindows\b/u.test(navigator.userAgent);
  const [mode, setMode] = useState<ViewMode>('split');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportSnapshot, setExportSnapshot] = useState<DocumentSnapshot | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchMessage, setSearchMessage] = useState('');
  const [presentation, setPresentation] = useState(false);
  const mixed = view.format.lineEnding === 'mixed';
  const previewInput = useMemo(() => ({ key: view.key, source }), [view.key, source]);
  const deferred = useDeferredValue(previewInput);
  const previewSource = deferred.key === view.key ? deferred.source : source;
  const outline = useMemo(() => outlineOpen ? buildSourceOutline(previewSource) : [], [previewSource, outlineOpen]);
  const cursor = useMemo(() => editorSelectionPosition(source, selection.start, selection.end), [source, selection]);
  const resolveImage = session.resolveImage;

  useLayoutEffect(() => {
    const editor = sourcePane.current && EditorView.findFromDOM(sourcePane.current);
    if (editor) editor.dispatch({ effects: StateEffect.appendConfig.of([history(), keymap.of(historyKeymap)]) });
  }, [view.key]);

  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);

  function openDocument() {
    if (desktop) return session.open();
    fileInput.current?.click();
  }

  function changeMode(next: ViewMode) {
    if (!session.canLeaveInput()) return;
    setPresentation(false);
    setMode(next);
  }

  function jump(start: number, end = start, focus = true) {
    if (!session.canLeaveInput()) return;
    if (mode === 'preview') setMode('split');
    setPresentation(false);
    requestAnimationFrame(() => {
      surface.current?.select({ start, end, direction: end === start ? 'none' : 'forward' }, true);
      if (focus) surface.current?.focus();
    });
  }

  function findNext(event: FormEvent) {
    event.preventDefault();
    const matches = findEditorTextMatches(session.currentSource(), query);
    const next = matches.find(match => match.start >= selection.end) ?? matches[0];
    setSearchMessage(!query ? '' : matches.length ? matches.length + ' 处匹配' : '无匹配');
    if (next) jump(next.start, next.end, false);
  }

  function moveHistory(direction: 'undo' | 'redo') {
    if (!session.canLeaveInput() || mixed) return;
    if (mode === 'preview') changeMode('split');
    const editor = sourcePane.current && EditorView.findFromDOM(sourcePane.current);
    if (editor) (direction === 'undo' ? undo : redo)(editor);
  }

  function exportDocument() {
    if (!session.canLeaveInput()) return;
    if (!plugins.formats.length) {
      session.setNotice('请在设置中启用至少一种导出格式。');
      return;
    }
    setExportSnapshot({
      name: view.name, source: session.currentSource(), revision: session.currentRevision(),
      dialect: 'commonmark-gfm-frontmatter', extensions: plugins.markdown, resolveImage,
    });
  }

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        menu.current?.removeAttribute('open');
        if (!exportSnapshot && !settingsOpen) {
          setPresentation(false);
          setSearchOpen(false);
        }
      }
      if (event.isComposing || (!event.ctrlKey && !event.metaKey) || event.altKey || settingsOpen || exportSnapshot) return;
      switch (event.key.toLowerCase()) {
        case 'o': event.preventDefault(); void openDocument(); break;
        case 's':
          event.preventDefault();
          if (!mixed || event.shiftKey) void session.save(event.shiftKey);
          break;
        case 'f': event.preventDefault(); setSearchOpen(true); search.current?.focus(); break;
        default: break;
      }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  function windowAction(action: 'minimize' | 'maximize' | 'close') {
    const current = getCurrentWindow();
    const result = action === 'minimize' ? current.minimize() : action === 'maximize' ? current.toggleMaximize() : current.close();
    void result.catch(() => session.setError('无法执行窗口操作。'));
  }

  function fileAction(action: () => void) {
    menu.current?.removeAttribute('open');
    action();
  }

  const focused = presentation && plugins.focusAvailable;
  const activeMode = focused ? 'preview' : mode;
  return (
    <div className="app" style={plugins.style} data-dark={plugins.dark}>
      <header className="topbar">
        <button className="sidebar-toggle" type="button" aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-controls="view-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>
          <span className="sidebar-glyph" aria-hidden="true" />
        </button>
        <nav className="menus" aria-label="应用操作">
          <details className="file-menu" ref={menu} onToggle={event => {
            if (event.currentTarget.open) void session.refreshLists();
          }} onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute('open');
          }}>
            <summary>文件</summary>
            <div className="menu-panel">
              <button type="button" onClick={() => fileAction(session.newDocument)} disabled={pending}>新建文档</button>
              {desktop && <button type="button" onClick={() => fileAction(session.newWindow)} disabled={pending}>新建窗口</button>}
              <button type="button" onClick={() => fileAction(openDocument)} disabled={pending}>打开文件 <kbd>Ctrl+O</kbd></button>
              <button type="button" onClick={() => fileAction(() => void session.save())} disabled={pending || mixed}>保存 <kbd>Ctrl+S</kbd></button>
              <button type="button" onClick={() => fileAction(() => void session.save(true))} disabled={pending}>另存为</button>
              {desktop && view.path && <button type="button" onClick={() => fileAction(session.reload)} disabled={pending}>从磁盘重新载入</button>}
              {session.recent.length > 0 && <div className="menu-group">
                <div className="menu-heading">最近打开</div>
                {session.recent.map(item => <button type="button" key={item.id} title={item.path}
                  onClick={() => fileAction(() => void session.openRecent(item.id))}>{item.name}</button>)}
              </div>}
              {session.drafts.length > 0 && <div className="menu-group">
                <div className="menu-heading">恢复草稿</div>
                {session.drafts.map(item => <button type="button" key={item.id} title={item.path ?? item.name}
                  onClick={() => fileAction(() => void session.restore(item.id))}>{item.name}</button>)}
              </div>}
            </div>
          </details>
          <button type="button" onClick={() => setSearchOpen(value => !value)} aria-expanded={searchOpen}>查找</button>
          <button type="button" onClick={() => setOutlineOpen(value => !value)} aria-expanded={outlineOpen}>目录</button>
          {plugins.focusAvailable && <button type="button" aria-pressed={focused} onClick={() => {
            if (session.canLeaveInput()) setPresentation(value => !value);
          }}>专注</button>}
          <button type="button" onClick={exportDocument} disabled={pending || !plugins.formats.length}>导出</button>
          <button type="button" onClick={() => {
            void session.refreshLists();
            setSettingsOpen(true);
          }}>设置</button>
        </nav>
        <div className="title-space" data-tauri-drag-region={windowsChrome || undefined}
          title={view.path ?? view.name}>{view.name}{dirty ? ' •' : ''}</div>
        {windowsChrome && <div className="window-actions" aria-label="窗口操作">
          <button type="button" aria-label="最小化" onClick={() => windowAction('minimize')}>−</button>
          <button type="button" aria-label="最大化或还原" onClick={() => windowAction('maximize')}>□</button>
          <button type="button" aria-label="关闭窗口" onClick={() => windowAction('close')}>×</button>
        </div>}
      </header>
      <main className="shell" data-expanded={sidebarOpen} data-presentation={focused}>
        <aside id="view-sidebar" className="sidebar" aria-label="编辑视图" hidden={!sidebarOpen}>
          <div className="mode-list">
            {MODES.map(item => <button key={item.value} type="button" aria-pressed={activeMode === item.value}
              onClick={() => changeMode(item.value)}>{item.label}</button>)}
          </div>
        </aside>
        <section className="document">
          {(session.notice || session.error || mixed) && <div className="document-bar">
            {mixed && <span className="dirty">混合换行 · 只读</span>}
            {session.notice && <span className="notice" role="status">{session.notice}</span>}
            {session.error && <span className="error" role="alert">{session.error}</span>}
            {session.conflict && <>
              <button type="button" onClick={session.reload}>重新载入</button>
              <button type="button" onClick={() => void session.save(true)}>另存为</button>
            </>}
            <button className="dismiss-notice" type="button" aria-label="关闭通知" onClick={() => {
              session.setNotice('');
              session.setError('');
            }}>×</button>
          </div>}
          {searchOpen && <form className="search-bar" onSubmit={findNext}>
            <input ref={search} aria-label="查找源码文字" placeholder="查找源码文字" value={query}
              onChange={event => { setQuery(event.target.value); setSearchMessage(''); }} />
            <button type="submit">下一处</button>
            <span role="status">{searchMessage}</span>
            <button type="button" aria-label="关闭查找" onClick={() => setSearchOpen(false)}>×</button>
          </form>}
          <div className="workspace" data-mode={activeMode}>
            <section className="pane source-pane" aria-label="源码编辑" hidden={activeMode === 'preview'} ref={sourcePane}>
              <SourceSurface ref={surface} documentKey={String(view.key)} documentName={view.name}
                value={source} readOnly={mixed || pending} softWrap onChange={session.edit}
                onSelect={session.setSelection} onKeyDown={event => {
                  if (event.key === 'Escape' && searchOpen) setSearchOpen(false);
                }} onContextMenu={() => undefined} />
            </section>
            {activeMode !== 'source' && <section className="pane preview-pane" aria-label="排版预览">
              <div className="reading-scroll" tabIndex={0}>
                <MarkdownPreview key={view.key} source={previewSource} extensions={plugins.markdown} resolveImage={resolveImage} />
              </div>
            </section>}
            {outlineOpen && <aside className="outline" aria-label="文档目录">
              <div className="outline-title">文档目录<button type="button" aria-label="关闭目录" onClick={() => setOutlineOpen(false)}>×</button></div>
              {outline.length ? outline.map(heading => <button type="button" key={heading.key}
                style={{ paddingInlineStart: 10 + Math.min(heading.depth - 1, 5) * 10 }}
                onClick={() => jump(heading.sourceOffset)}>{heading.title}</button>) : <p>文档暂无标题</p>}
            </aside>}
          </div>
          <footer className="statusbar">
            <div className="status-actions">
              <button type="button" onClick={() => moveHistory('undo')} disabled={mixed || pending} aria-label="撤销">↶</button>
              <button type="button" onClick={() => moveHistory('redo')} disabled={mixed || pending} aria-label="重做">↷</button>
              <span>行 {cursor.line}，列 {cursor.column}</span>
            </div>
            <span>UTF-8{view.format.bomByteLength === 3 ? ' BOM' : ''} · {view.format.lineEnding === 'none' ? '单行' : view.format.lineEnding.toUpperCase()}</span>
          </footer>
        </section>
      </main>
      <input ref={fileInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void session.openBrowserFile(file);
      }} />
      {settingsOpen && <Settings desktop={desktop} plugins={plugins} drafts={session.drafts} onDiscardDraft={session.discard}
        onClose={() => setSettingsOpen(false)} launchDefaults={() => invoke('set_default_markdown_app')} />}
      {desktop && !pending && !plugins.preferences.configured &&
        <FirstRun plugins={plugins} onClose={() => undefined} />}
      {exportSnapshot && <ExportDialog snapshot={exportSnapshot} formats={plugins.formats} onClose={() => setExportSnapshot(null)}
        onSaved={result => session.setNotice('已导出 ' + result)} />}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('页面容器未找到。');
createRoot(root).render(<StrictMode><App /></StrictMode>);
