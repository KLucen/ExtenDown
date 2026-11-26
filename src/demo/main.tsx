import { history, redo, undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { StrictMode, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { editorSelectionPosition, markdownToEditorText } from '../core/editor-text';
import { buildSourceCommandPatch, EDITOR_COMMANDS, isSourceCommand, shortcutLabel, type EditorCommand, type EditorCommandId, type SourcePatch } from '../core/editor-commands';
import type { DocumentSnapshot } from '../core/export';
import { buildSourceOutline } from '../core/source-outline';
import { parseMarkdownSnapshot } from '../core/markdown-snapshot';
import { builtinMathModule, builtinMermaidModule, extraLanguagesExtension } from '../core/plugins/builtin';
import type { Nodes } from 'mdast';
import { ExportDialog } from '../renderer/export-dialog';
import { MarkdownPreview, type PreviewEditing, type PreviewSourceRange } from '../renderer/markdown-preview';
import { SourceSurface } from '../renderer/source-surface';
import type { SourceSurfaceHandle } from '../renderer/source-surface';
import { useDocument } from './document-session';
import { ScriptCommands, useScriptPlugins, type ScriptRunEntry } from './script-commands';
import { Settings, useExtensions } from './settings';
import { CommandPalette, EditorSearch, useCommandShortcuts, useShortcuts } from './commands';
import { WorkspacePanel } from './workspace-panel';
import { ReadingSearch, useSplitScroll } from './preview-navigation';
import './style.css';

type ViewMode = 'source' | 'split' | 'preview';
const MODES = [
  { value: 'source', label: '源码' },
  { value: 'split', label: '并排' },
  { value: 'preview', label: '预览' },
] as const;
const EXTRA_FENCE_LANGUAGES = ['c', 'cpp', 'csharp', 'go', 'java', 'lua', 'markdown', 'powershell'];

function detectOptionalSyntax(source: string, mathActive: boolean, mermaidActive: boolean) {
  const found = new Set<'math' | 'mermaid'>();
  if (mathActive && mermaidActive) return found;
  const { root } = parseMarkdownSnapshot(source, { math: !mathActive });
  function visit(node: Nodes) {
    if (!mathActive && (node.type === 'math' || node.type === 'inlineMath')) found.add('math');
    if (!mermaidActive && node.type === 'code' && node.lang?.toLowerCase() === 'mermaid') found.add('mermaid');
    if ('children' in node) node.children.forEach(visit);
  }
  visit(root);
  return found;
}

function App() {
  const surface = useRef<SourceSurfaceHandle>(null);
  const sourcePane = useRef<HTMLElement>(null);
  const readingPane = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const previewActivity = useRef(new Set<string>());
  const previewInputActive = () => previewActivity.current.size > 0;
  const session = useDocument(surface, previewInputActive);
  const { view, source, selection, desktop, dirty, pending } = session;
  const plugins = useExtensions();
  const scriptPlugins = useScriptPlugins();
  const windowsChrome = desktop && /\bWindows\b/u.test(navigator.userAgent);
  const [mode, setMode] = useState<ViewMode>('split');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const shortcuts = useShortcuts();
  const [settings, setSettings] = useState<{ tab: 'general' | 'plugins' | 'shortcuts'; query?: string } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scriptCommand, setScriptCommand] = useState<string | null>(null);
  const [scriptHistory, setScriptHistory] = useState<ScriptRunEntry[]>([]);
  const [exportSnapshot, setExportSnapshot] = useState<DocumentSnapshot | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<'find' | 'replace' | 'reading' | null>(null);
  const [syncScroll, setSyncScroll] = useState(true);
  const [presentation, setPresentation] = useState(false);
  const mixed = view.format.lineEnding === 'mixed';
  const revision = session.currentRevision();
  const previewInput = useMemo(() => ({ key: view.key, source, revision }), [view.key, source, revision]);
  const deferred = useDeferredValue(previewInput);
  const previewSource = deferred.key === view.key ? deferred.source : source;
  const outline = useMemo(() => outlineOpen ? buildSourceOutline(previewSource) : [], [previewSource, outlineOpen]);
  const cursor = useMemo(() => editorSelectionPosition(source, selection.start, selection.end), [source, selection]);
  const resolveImage = session.resolveImage;
  const fenceLanguages = useMemo(() => [
    ...(plugins.markdown.some(item => item.id === extraLanguagesExtension.id) ? EXTRA_FENCE_LANGUAGES : []),
    ...(plugins.markdown.some(item => item.id === builtinMermaidModule.manifest.id) ? ['mermaid'] : []),
  ], [plugins.markdown]);
  const optionalSyntax = useMemo(() => detectOptionalSyntax(previewSource,
    plugins.markdown.some(item => item.id === builtinMathModule.manifest.id),
    plugins.markdown.some(item => item.id === builtinMermaidModule.manifest.id)), [previewSource, plugins.markdown]);

  useLayoutEffect(() => {
    const editor = sourcePane.current && EditorView.findFromDOM(sourcePane.current);
    if (editor) editor.dispatch({ effects: StateEffect.appendConfig.of(history()) });
  }, [view.key]);

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

  function moveHistory(direction: 'undo' | 'redo') {
    if (!session.canLeaveInput() || mixed) return;
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
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !previewInputActive()) {
        menu.current?.removeAttribute('open');
        if (!exportSnapshot && !settings && !paletteOpen && scriptCommand === null) {
          setPresentation(false);
          setSearchMode(null);
        }
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
  useSplitScroll(sourcePane, readingPane, view.key, activeMode === 'split' && syncScroll);
  const writable = !mixed && !pending;

  function patchSource(patch: SourcePatch, expectedSource: string) {
    return writable && session.canLeaveInput() && (surface.current?.applyPatch(patch, expectedSource) ?? false);
  }

  function sourceCommand(id: EditorCommandId, insertAtEnd = false) {
    if (!session.canLeaveInput() || (!writable && id !== 'edit.copy') || !surface.current) return;
    const original = session.currentSource();
    const currentSelection = insertAtEnd
      ? { start: original.length, end: original.length, direction: 'none' as const } : surface.current.selection();
    if (id === 'edit.copy' || id === 'edit.cut' || id === 'edit.paste') {
      void (async () => {
        try {
          const { start, end } = currentSelection;
          const expected = original.slice(start, end);
          if (id === 'edit.paste') {
            const insert = markdownToEditorText(await navigator.clipboard.readText());
            if (session.currentRevision() !== revision || session.currentSource() !== original) return;
            patchSource({ start, end, expected, insert }, original);
          } else if (expected) {
            await navigator.clipboard.writeText(expected);
            if (id === 'edit.cut' && session.currentRevision() === revision) patchSource({ start, end, expected, insert: '' }, original);
          }
        } catch { session.setError('无法访问剪贴板。'); }
      })();
      return;
    }
    const patch = buildSourceCommandPatch(id, original, currentSelection);
    if (patch && patchSource(patch, original) && !insertAtEnd) surface.current.focus();
  }

  function openSettings(tab: 'general' | 'plugins' | 'shortcuts' = 'general', query?: string) {
    if (!session.canLeaveInput()) return;
    void session.refreshLists();
    setSettings({ tab, query });
  }

  const handlers: Partial<Record<EditorCommandId, () => void>> = {
    'file.new': session.newDocument, 'file.open': openDocument, 'file.save': () => void session.save(),
    'file.save-as': () => void session.save(true), 'file.new-window': desktop ? session.newWindow : undefined,
    'file.reload': desktop && view.path ? session.reload : undefined, 'file.export': exportDocument,
    'edit.find': () => {
      const next = activeMode === 'preview' ? 'reading' : 'find';
      setSearchMode(next);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(next === 'reading' ? 'input[aria-label="查找预览文字"]' : '#editor-search-query')?.focus());
    },
    'edit.replace': () => setSearchMode('replace'),
    'edit.undo': () => moveHistory('undo'), 'edit.redo': () => moveHistory('redo'),
    'view.source': () => changeMode('source'), 'view.split': () => changeMode('split'),
    'view.preview': () => changeMode('preview'), 'view.outline': () => setOutlineOpen(value => !value),
    'view.focus': plugins.focusAvailable ? () => { if (session.canLeaveInput()) setPresentation(value => !value); } : undefined,
    'view.workspace': desktop ? () => setWorkspaceOpen(value => !value) : undefined,
    'app.commands': () => { if (session.canLeaveInput()) setPaletteOpen(true); },
    'app.settings': () => openSettings(), 'app.shortcuts': () => openSettings('shortcuts'),
    'app.script-history': scriptHistory.length ? () => setScriptCommand('') : undefined,
  };
  const commands: EditorCommand[] = (Object.keys(EDITOR_COMMANDS) as EditorCommandId[]).flatMap(id => {
    const item = EDITOR_COMMANDS[id];
    const sourceOnly = isSourceCommand(id);
    const run = sourceOnly ? () => sourceCommand(id) : handlers[id];
    if (!run || id === 'app.commands' && paletteOpen) return [];
    const enabled = sourceOnly ? activeMode !== 'preview' && (writable || id === 'edit.copy')
      : id === 'file.save' || id === 'edit.undo' || id === 'edit.redo' ? writable
      : id === 'file.export' ? !pending && plugins.formats.length > 0 : !pending;
    return [{ ...item, enabled, run: () => { if (session.canLeaveInput()) run(); } }];
  });
  for (const record of scriptPlugins.records) {
    if (!record.enabled) continue;
    for (const id of record.current.manifest.contributes) commands.push({
      id: 'plugin:' + id, label: record.current.manifest.name + ' · ' + id, category: '插件', scope: 'app', source: record.current.manifest.name,
      enabled: !pending, run: () => { if (session.canLeaveInput()) setScriptCommand(id); },
    });
  }
  function runCommand(id: EditorCommandId) {
    const command = commands.find(item => item.id === id);
    if (command?.enabled) command.run();
  }
  const shortcut = (id: EditorCommandId) => shortcutLabel(EDITOR_COMMANDS[id], shortcuts.overrides, shortcuts.mac);
  useCommandShortcuts({
    commands, shortcuts, blocked: Boolean(settings || exportSnapshot || paletteOpen || scriptCommand !== null),
    canRun: (event, command) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-reader-editable="true"]') &&
        (command.scope === 'source' || command.id === 'edit.undo' || command.id === 'edit.redo')) return false;
      if (previewInputActive() && command.scope === 'app') {
        session.canLeaveInput();
        return true;
      }
      if (command.scope === 'source') return Boolean(target?.closest('[data-source-input]'));
      if ((command.id === 'edit.undo' || command.id === 'edit.redo') && target?.closest('input,textarea')) return false;
      return true;
    },
  });

  function previewRangeCurrent(request: PreviewSourceRange) {
    return String(view.key) === request.documentKey && session.currentRevision() === request.revision &&
      session.currentSource().slice(request.from, request.to) === request.expected;
  }
  const editing: PreviewEditing = {
    documentKey: String(view.key), revision: deferred.key === view.key ? deferred.revision : revision,
    current: previewSource === source && (deferred.key !== view.key || deferred.revision === revision),
    writable: writable && !focused,
    shortcuts: shortcuts.overrides,
    onEdit: request => {
      if (!writable || !previewRangeCurrent(request)) return false;
      const applied = surface.current?.applyPatch({
        start: request.from, end: request.to, expected: request.expected, insert: request.insert, selection: request.selection,
      }) ?? false;
      if (applied && request.revealSource) {
        setMode('split');
        requestAnimationFrame(() => surface.current?.focus());
      }
      return applied;
    },
    onOpenSource: request => {
      if (!previewRangeCurrent(request) || !session.canLeaveInput()) return false;
      jump(request.from, request.to);
      return true;
    },
    onInsert: id => sourceCommand(id, true),
    onActivityChange: (kind, active) => {
      if (active) previewActivity.current.add(kind);
      else previewActivity.current.delete(kind);
    },
  };
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
              <button type="button" onClick={() => fileAction(() => runCommand('file.new'))} disabled={pending}>新建文档 <kbd>{shortcut('file.new')}</kbd></button>
              {desktop && <button type="button" onClick={() => fileAction(session.newWindow)} disabled={pending}>新建窗口</button>}
              <button type="button" onClick={() => fileAction(() => runCommand('file.open'))} disabled={pending}>打开文件 <kbd>{shortcut('file.open')}</kbd></button>
              <button type="button" onClick={() => fileAction(() => runCommand('file.save'))} disabled={pending || mixed}>保存 <kbd>{shortcut('file.save')}</kbd></button>
              <button type="button" onClick={() => fileAction(() => runCommand('file.save-as'))} disabled={pending}>另存为 <kbd>{shortcut('file.save-as')}</kbd></button>
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
          <button type="button" onClick={() => searchMode ? setSearchMode(null) : runCommand('edit.find')} aria-expanded={Boolean(searchMode)}>查找</button>
          <button type="button" onClick={() => runCommand('view.outline')} aria-expanded={outlineOpen}>目录</button>
          {plugins.focusAvailable && <button type="button" aria-pressed={focused} onClick={() => {
            if (session.canLeaveInput()) setPresentation(value => !value);
          }}>专注</button>}
          <button type="button" onClick={() => runCommand('file.export')} disabled={pending || !plugins.formats.length}>导出</button>
          <button type="button" disabled={pending} onClick={() => runCommand('app.commands')} title={shortcut('app.commands')}>命令</button>
          {desktop && <button type="button" aria-expanded={workspaceOpen} aria-controls="workspace-panel" onClick={() => runCommand('view.workspace')}>工作区</button>}
          <button type="button" onClick={() => openSettings()} title={shortcut('app.settings')}>设置</button>
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
              onClick={() => runCommand(`view.${item.value}`)}>{item.label}</button>)}
          </div>
        </aside>
        {desktop && <WorkspacePanel open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} session={session}
          onJumpToPosition={offset => jump(offset)} />}
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
          {searchMode === 'reading' && activeMode !== 'source'
            ? <ReadingSearch key={view.key} documentKey={String(view.key)} source={previewSource} onClose={() => setSearchMode(null)} />
            : searchMode && <EditorSearch mode={searchMode === 'reading' ? 'find' : searchMode} source={source} selection={selection}
            readSource={session.currentSource} onSelect={(start, end) => jump(start, end, false)}
            onPatch={patchSource}
            onReplaceAll={(value, expected) => patchSource({ start: 0, end: expected.length, expected, insert: value }, expected)}
            readOnly={!writable} onClose={() => setSearchMode(null)} onModeChange={setSearchMode} />}
          <div className="workspace" data-mode={activeMode}>
            <section className="pane source-pane" aria-label="源码编辑" hidden={activeMode === 'preview'} ref={sourcePane}>
              <SourceSurface ref={surface} documentKey={String(view.key)} documentName={view.name}
                value={source} readOnly={mixed || pending} softWrap onChange={session.edit}
                additionalFenceLanguages={fenceLanguages}
                onSelect={session.setSelection} onKeyDown={event => {
                  if (event.key === 'Escape' && searchMode) setSearchMode(null);
                }} onCommand={runCommand} shortcuts={shortcuts.overrides} />
            </section>
            {activeMode !== 'source' && <section className="pane preview-pane" aria-label="排版预览">
              <div className="reading-scroll" tabIndex={0} ref={readingPane}>
                {plugins.componentsReady && optionalSyntax.size > 0 && <div className="extension-hints">
                  {[...optionalSyntax].map(id => <button className="setting-action" type="button" key={id}
                    onClick={() => openSettings('plugins', id === 'math' ? '数学公式' : 'Mermaid')}>
                    {id === 'math' ? '数学公式' : 'Mermaid'} · {plugins.components.has(id) ? '查看启用状态' : '未安装'}
                  </button>)}
                </div>}
                <MarkdownPreview key={view.key} source={previewSource} extensions={plugins.markdown} resolveImage={resolveImage}
                  editing={!focused ? editing : undefined} />
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
              {activeMode === 'split' && <button type="button" aria-pressed={syncScroll}
                onClick={() => setSyncScroll(value => !value)}>同步滚动</button>}
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
      {settings && <Settings desktop={desktop} plugins={plugins} scripts={scriptPlugins} drafts={session.drafts} onDiscardDraft={session.discard}
        onClose={() => setSettings(null)} launchDefaults={() => invoke('set_default_markdown_app')} shortcuts={shortcuts} commands={commands}
        initialTab={settings.tab} pluginQuery={settings.query} />}
      {paletteOpen && <CommandPalette commands={commands} shortcuts={shortcuts} onClose={() => setPaletteOpen(false)} />}
      {scriptCommand !== null && <ScriptCommands records={scriptPlugins.records} initialCommand={scriptCommand || undefined}
        onClose={() => setScriptCommand(null)}
        history={scriptHistory} onRunEntry={entry => setScriptHistory(previous => [entry, ...previous.slice(0, 19)])}
        readDocument={() => pending || !session.canLeaveInput() ? null : {
          key: view.key, revision: session.currentRevision(), source: session.currentSource(), format: view.format,
        }}
        replaceText={value => !pending && !mixed && (surface.current?.replaceText(value) ?? false)} />}
      {exportSnapshot && <ExportDialog snapshot={exportSnapshot} formats={plugins.formats} onClose={() => setExportSnapshot(null)}
        onSaved={result => session.setNotice('已导出 ' + result)} />}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('页面容器未找到。');
createRoot(root).render(<StrictMode><App /></StrictMode>);
