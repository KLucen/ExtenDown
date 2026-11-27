import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react';
import { useConfirmation } from './confirmation-dialog';
import { errorMessage, useDocument, type WorkspaceDiskStatus } from './document-session';
import { hasAnchor, markdownAnchors, offsetAtLine, readLocalLinks } from './workspace-links';
import './workspace-panel.css';

interface Root { id: string; name: string; path: string }
interface Entry { name: string; path: string; directory: boolean; document: boolean; linked: boolean }
interface Listing { entries: Entry[]; limited: boolean }
interface CurrentFile { relative: string; status: WorkspaceDiskStatus }
interface SearchHit { path: string; line: number | null; preview: string | null }
interface SearchResults { hits: SearchHit[]; limited: boolean; skipped: number }
interface CheckedLink { status: 'ok' | 'missing' | 'outside' | 'unverified'; source: string | null }
interface Issue { line: number; label: string; message: string }
interface Menu { entry: Entry; left: number; top: number; origin: HTMLElement }
interface NameEdit { kind: 'create' | 'rename'; path: string; value: string }

const ROOT_PATH = '';
const ROOT_ONLY = [ROOT_PATH];
const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

interface WorkspacePanelProps {
  open: boolean;
  onClose: () => void;
  session: ReturnType<typeof useDocument>;
  onJumpToPosition?: (offset: number) => void;
}

export function WorkspacePanel({ open, onClose, session, onJumpToPosition }: WorkspacePanelProps) {
  const [root, setRoot] = useState<Root | null>(null);
  const rootRef = useRef<Root | null>(null);
  const [expanded, setExpanded] = useState(ROOT_ONLY);
  const [folders, setFolders] = useState<Record<string, Listing>>({});
  const [folderErrors, setFolderErrors] = useState<Record<string, string>>({});
  const [current, setCurrent] = useState<CurrentFile | null>(null);
  const [activeFolder, setActiveFolder] = useState(ROOT_PATH);
  const [locate, setLocate] = useState<string | null>(null);
  const [tab, setTab] = useState<'tree' | 'search' | 'links'>('tree');
  const [query, setQuery] = useState('');
  const [inContents, setInContents] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [linkLimit, setLinkLimit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [nameEdit, setNameEdit] = useState<NameEdit | null>(null);
  const confirmation = useConfirmation();
  const list = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const nameDialog = useRef<HTMLDialogElement>(null);
  const jump = useRef(onJumpToPosition);
  const diskStatus = useRef(session.noteWorkspaceDiskStatus);
  const statusVersion = useRef(0);
  const searchVersion = useRef(0);
  const handledLocation = useRef(session.workspaceLocation);
  jump.current = onJumpToPosition;
  diskStatus.current = session.noteWorkspaceDiskStatus;

  useEffect(() => {
    const location = session.workspaceLocation;
    if (!location || location === handledLocation.current || location.documentId !== session.view.documentId) return;
    const frame = window.requestAnimationFrame(() => {
      handledLocation.current = location;
      jump.current?.(offsetAtLine(session.currentSource(), location.line));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [session.workspaceLocation, session.view.documentId]);

  useEffect(() => {
    if (!nameEdit || nameDialog.current?.open) return;
    nameDialog.current?.showModal();
  }, [nameEdit]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('button:not(:disabled)')?.setAttribute('data-menu-focus', '');
    menuRef.current?.querySelector<HTMLElement>('[data-menu-focus]')?.focus();
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(null);
    }
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [menu]);

  const loadDirectories = useCallback(async (selected: Root, paths: string[]) => {
    await Promise.all(paths.map(async relative => {
      try {
        const entries = await invoke<Listing>('workspace_list', { workspaceId: selected.id, relative });
        if (rootRef.current?.id !== selected.id) return;
        setFolders(previous => JSON.stringify(previous[relative]) === JSON.stringify(entries)
          ? previous : { ...previous, [relative]: entries });
        setFolderErrors(previous => {
          if (!(relative in previous)) return previous;
          const remaining = { ...previous };
          delete remaining[relative];
          return remaining;
        });
      } catch (reason) {
        if (rootRef.current?.id !== selected.id) return;
        const failure = errorMessage(reason, '无法读取文件夹。');
        setFolders(previous => {
          if (!(relative in previous)) return previous;
          const remaining = { ...previous };
          delete remaining[relative];
          return remaining;
        });
        setFolderErrors(previous => previous[relative] === failure ? previous : { ...previous, [relative]: failure });
      }
    }));
  }, []);

  const documentId = session.view.documentId;
  const documentPath = session.view.path;
  const revision = session.view.revision;
  const updateCurrent = useCallback(async (selected: Root, id: string) => {
    const version = ++statusVersion.current;
    try {
      const file = await invoke<CurrentFile | null>('workspace_current_file', { workspaceId: selected.id, documentId: id });
      if (version !== statusVersion.current || selected.id !== rootRef.current?.id) return;
      setCurrent(previous => previous?.relative === file?.relative && previous?.status === file?.status ? previous : file);
      if (file) diskStatus.current(file.status);
    } catch {
      if (version === statusVersion.current && selected.id === rootRef.current?.id) setCurrent(null);
    }
  }, []);

  useEffect(() => {
    setCurrent(null);
    setIssues(null);
    if (!root || !documentId || !documentPath) return;
    const check = () => { if (document.visibilityState === 'visible') void updateCurrent(root, documentId); };
    check();
    const timer = window.setInterval(check, 3000);
    window.addEventListener('focus', check);
    return () => {
      statusVersion.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [root, documentId, documentPath, revision, updateCurrent]);

  useEffect(() => {
    if (!root || !open) return;
    let updating = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || updating) return;
      updating = true;
      try {
        await loadDirectories(root, expanded);
      } finally {
        updating = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [root, expanded, open, loadDirectories]);

  useEffect(() => {
    if (!locate || !list.current) return;
    const element = Array.from(list.current.querySelectorAll<HTMLButtonElement>('button[data-relative]'))
      .find(button => button.dataset.relative === locate);
    if (!element) return;
    element.scrollIntoView({ block: 'nearest' });
    element.focus({ preventScroll: true });
    setLocate(null);
  }, [folders, locate, tab, open]);

  function activateRoot(selected: Root | null) {
    rootRef.current = selected;
    searchVersion.current += 1;
    setRoot(selected);
    setFolders({});
    setFolderErrors({});
    setExpanded(ROOT_ONLY);
    setActiveFolder(ROOT_PATH);
    setResults(null);
    setIssues(null);
    setMenu(null);
    setLocate(null);
    setTab('tree');
    setQuery('');
  }

  async function run(action: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason, fallback));
    } finally {
      setBusy(false);
    }
  }

  function chooseRoot() {
    return run(async () => {
      const selected = await invoke<Root | null>('choose_workspace');
      if (selected) activateRoot(selected);
    }, '无法打开工作区。');
  }

  function closeRoot() {
    if (!root) return;
    return run(async () => {
      await invoke('close_workspace', { workspaceId: root.id });
      activateRoot(null);
    }, '无法关闭工作区。');
  }

  function toggleFolder(relative: string) {
    if (relative === ROOT_PATH) return;
    const closing = expanded.includes(relative);
    setExpanded(previous => closing
      ? previous.filter(path => path !== relative && !path.startsWith(relative + '/'))
      : [...previous, relative]);
    const inside = activeFolder === relative || activeFolder.startsWith(relative + '/');
    setActiveFolder(closing ? (inside ? parentPath(relative) : activeFolder) : relative);
  }

  function locateFile() {
    if (!current || current.status === 'missing') return;
    const folders = current.relative.split('/').slice(0, -1);
    setExpanded(previous => [...new Set([...previous, ...folders.map((_, index) => folders.slice(0, index + 1).join('/'))])]);
    setTab('tree');
    setActiveFolder(parentPath(current.relative));
    setLocate(current.relative);
  }

  function openFile(relative: string, newWindow = false, line?: number) {
    if (!root || session.pending) return;
    if (current?.relative === relative && current.status !== 'missing') {
      if (line !== undefined && session.canLeaveInput()) jump.current?.(offsetAtLine(session.currentSource(), line));
      return;
    }
    void session.openWorkspaceFile(root.id, relative, newWindow, line);
  }

  function showMenu(entry: Entry, origin: HTMLElement, x: number, y: number) {
    setMenu({ entry, origin, left: Math.max(8, Math.min(x, window.innerWidth - 210)),
      top: Math.max(8, Math.min(y, window.innerHeight - 230)) });
  }

  function contextMenu(event: MouseEvent, entry: Entry) {
    event.preventDefault();
    const row = event.currentTarget as HTMLElement;
    const origin = row.querySelector<HTMLButtonElement>('[data-relative]') ?? row;
    showMenu(entry, origin, event.clientX, event.clientY);
  }

  function keyMenu(event: KeyboardEvent<HTMLButtonElement>, entry: Entry) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    showMenu(entry, event.currentTarget, bounds.left, bounds.bottom);
  }

  function closeMenu(restoreFocus: boolean) {
    if (restoreFocus) menu?.origin.focus();
    setMenu(null);
  }

  async function trashEntry(selected: Root, entry: Entry) {
    closeMenu(true);
    if (!session.canLeaveInput() || !await confirmation.confirm({
      title: '移到回收站',
      description: '将「' + entry.name + '」移到回收站。',
      confirmLabel: '移到回收站',
      variant: 'danger',
    })) return;
    if (rootRef.current?.id !== selected.id || !session.canLeaveInput()) return;
    await run(async () => {
      await invoke('workspace_trash', { workspaceId: selected.id, relative: entry.path });
      if (activeFolder === entry.path || activeFolder.startsWith(entry.path + '/')) {
        setActiveFolder(parentPath(entry.path));
      }
      const remaining = expanded.filter(path => path !== entry.path && !path.startsWith(entry.path + '/'));
      setExpanded(remaining);
      await loadDirectories(selected, remaining);
    }, '无法移到回收站。');
  }

  async function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!root || !nameEdit || !nameEdit.value) return;
    await run(async () => {
      const { value, path, kind } = nameEdit;
      if (kind === 'rename') {
        if (!await session.renameWorkspaceEntry(root.id, path, value)) return;
        const updated = (parentPath(path) ? parentPath(path) + '/' : '') + value;
        const retarget = (subpath: string) => subpath === path || subpath.startsWith(path + '/')
          ? updated + subpath.slice(path.length) : subpath;
        const directories = expanded.map(retarget);
        setExpanded(directories);
        setActiveFolder(retarget(activeFolder));
        setLocate(updated);
        await loadDirectories(root, directories);
      } else {
        const created = await invoke<string>('workspace_create', { workspaceId: root.id, parent: path, name: value });
        setExpanded(previous => [...new Set([...previous, path])]);
        setLocate(created);
        await loadDirectories(root, [path]);
        openFile(created);
      }
      setTab('tree');
      setNameEdit(null);
    }, '无法保存工作区项目。');
  }

  function renderDirectory(relative: string, depth: number) {
    const listing = folders[relative];
    const failure = folderErrors[relative];
    if (failure || !listing?.entries.length) return (
      <p className="workspace-empty" style={{ paddingInlineStart: depth * 12 + 10 }}>
        {failure || (listing ? (listing.limited ? '项目较多，显示上限已达' : '空文件夹') : '正在读取…')}
      </p>
    );
    return <>
      {listing.entries.map(entry => {
      const canExpand = entry.directory && depth < 64;
      const unfolded = canExpand && expanded.includes(entry.path);
      return <div key={entry.path}>
        <div className="workspace-file-row" data-active={current?.relative === entry.path}
          onContextMenu={event => contextMenu(event, entry)} style={{ paddingInlineStart: depth * 12 }}>
          <button type="button" className="workspace-file-name" data-relative={entry.path} title={entry.path}
            aria-current={current?.relative === entry.path ? 'page' : undefined}
            aria-expanded={canExpand ? unfolded : undefined} disabled={entry.directory && !canExpand}
            onClick={() => { if (canExpand) toggleFolder(entry.path); else if (entry.document) openFile(entry.path); }}
            onKeyDown={event => keyMenu(event, entry)}>
            <span className="workspace-file-icon" aria-hidden="true">{entry.directory ? (unfolded ? '▾' : '▸') : '·'}</span>
            <span>{entry.name}</span>
            {entry.linked && <span aria-label="链接">↗</span>}
          </button>
          <button type="button" className="workspace-row-menu" aria-label={'操作 ' + entry.name}
            onClick={event => {
              const bounds = event.currentTarget.getBoundingClientRect();
              showMenu(entry, event.currentTarget, bounds.left, bounds.bottom);
            }}>⋯</button>
        </div>
        {unfolded && renderDirectory(entry.path, depth + 1)}
      </div>;
      })}
      {listing.limited && <p className="workspace-empty" style={{ paddingInlineStart: depth * 12 + 10 }}>
        文件夹包含超过 10,000 个项目，已显示前 10,000 项
      </p>}
    </>;
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!root || !query.trim()) return;
    void run(async () => {
      const version = ++searchVersion.current;
      const response = await invoke<SearchResults>('workspace_search', { workspaceId: root.id, query, inContents });
      if (version === searchVersion.current) setResults(response);
    }, '无法搜索工作区。');
  }

  function checkLinks() {
    if (!root || !documentId) return;
    void run(async () => {
      const source = session.currentSource();
      const version = session.currentRevision();
      const local = readLocalLinks(source);
      const linkTargets = new Map<string, { path: string; withFragment: boolean }>();
      const selected = local.slice(0, 500);
      for (const link of selected) {
        if (!link.path) continue;
        const existing = linkTargets.get(link.path);
        linkTargets.set(link.path, { path: link.path, withFragment: Boolean(existing?.withFragment || link.fragment) });
      }
      const targets = [...linkTargets.values()];
      const checked = targets.length
        ? await invoke<CheckedLink[]>('workspace_check_links', { workspaceId: root.id, documentId, links: targets })
        : [];
      if (version !== session.currentRevision()) {
        setMessage('正文已有修改，请重新检查链接。');
        return;
      }
      const checks = new Map(targets.map((target, index) => [target.path, checked[index]]));
      const anchors = new Map<string, ReadonlySet<string>>();
      const failures: Issue[] = [];
      for (const link of selected) {
        const result = checks.get(link.path);
        let failure = '';
        switch (result?.status) {
          case 'missing': failure = '目标不存在'; break;
          case 'outside': failure = '目标超出工作区范围'; break;
          case 'unverified': failure = '无法验证目标'; break;
          default:
            if (link.fragment && (!link.path || typeof result?.source === 'string')) {
              let targetAnchors = anchors.get(link.path);
              if (!targetAnchors) {
                targetAnchors = markdownAnchors(link.path ? result?.source ?? '' : source);
                anchors.set(link.path, targetAnchors);
              }
              if (!hasAnchor(link.fragment, targetAnchors)) failure = '目标标题不存在';
            }
        }
        if (failure) failures.push({ line: link.line, label: link.label, message: failure });
      }
      setIssues(failures);
      setLinkLimit(local.length > selected.length);
    }, '无法检查本地链接。');
  }

  const menuEntry = menu?.entry;
  const rootLabel = root ? <div className="workspace-path" title={root.path}>
    <button type="button" onClick={() => { setTab('tree'); setActiveFolder(ROOT_PATH); }}>{root.name}</button>
    {activeFolder.split('/').filter(Boolean).map((segment, index, parts) =>
      <span key={index}><span aria-hidden="true"> / </span><button type="button" onClick={() => {
        const path = parts.slice(0, index + 1).join('/');
        setTab('tree');
        setActiveFolder(path);
        setLocate(path);
      }}>{segment}</button></span>)}
  </div> : null;

  return <><aside id="workspace-panel" className="document-workspace" aria-label="工作区" hidden={!open}>
    <header className="workspace-panel-header"><span>工作区</span>
      <button type="button" aria-label="收起工作区" onClick={() => { setMenu(null); onClose(); }}>×</button>
    </header>
    <div className="workspace-controls">
      <button type="button" disabled={busy} onClick={chooseRoot}>{root ? '更换文件夹' : '打开文件夹'}</button>
      {root && <>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          await loadDirectories(root, expanded);
          if (documentId) await updateCurrent(root, documentId);
        }, '无法刷新工作区。')}>刷新</button>
        <button type="button" disabled={busy} onClick={closeRoot}>关闭文件夹</button>
      </>}
    </div>
    {rootLabel}
    {root && <>
      <div className="workspace-tabs" aria-label="工作区视图">
        <button type="button" aria-pressed={tab === 'tree'} onClick={() => setTab('tree')}>文件树</button>
        <button type="button" aria-pressed={tab === 'search'} onClick={() => setTab('search')}>搜索</button>
        <button type="button" aria-pressed={tab === 'links'} onClick={() => setTab('links')}>链接检查</button>
      </div>
      {tab === 'tree' && <>
        <div className="workspace-controls workspace-tree-controls">
          <button type="button" disabled={!current || current.status === 'missing'} onClick={locateFile}>定位当前文档</button>
          <button type="button" disabled={busy || session.pending}
            onClick={() => setNameEdit({ kind: 'create', path: activeFolder, value: '新建文档.md' })}>新建文档</button>
        </div>
        <div className="workspace-list" ref={list}>{renderDirectory(ROOT_PATH, 0)}</div>
      </>}
      {tab === 'search' && <>
        <form className="workspace-search" onSubmit={submitSearch}>
          <label><span>搜索范围</span><select value={inContents ? 'text' : 'name'} onChange={event => {
            searchVersion.current += 1;
            setInContents(event.currentTarget.value === 'text');
            setResults(null);
          }}>
            <option value="name">文件名或路径</option><option value="text">正文内容</option>
          </select></label>
          <div><input aria-label="工作区搜索词" placeholder={inContents ? '输入正文关键词' : '输入文件名或路径'}
            value={query} maxLength={250} onChange={event => {
              searchVersion.current += 1;
              setQuery(event.currentTarget.value);
              setResults(null);
            }} />
            <button type="submit" disabled={busy || !query.trim()}>搜索</button></div>
        </form>
        <div className="workspace-list workspace-results">
          {results && <>
            <p className="workspace-empty">{results.hits.length ? results.hits.length + ' 条结果' : '没有匹配的文档'}
              {results.limited && ' · 已达搜索上限'}{results.skipped > 0 && ' · 跳过 ' + results.skipped + ' 项'}
            </p>
            {results.hits.map(hit => <button type="button" key={hit.path + ':' + hit.line} title={hit.path}
              disabled={session.pending} onClick={() => openFile(hit.path, false, hit.line ?? undefined)}>
              <span>{hit.path}{hit.line && <small> · 第 {hit.line} 行</small>}</span>
              {hit.preview && <small>{hit.preview}</small>}
            </button>)}
          </>}
        </div>
      </>}
      {tab === 'links' && <>
        <div className="workspace-controls workspace-tree-controls">
          <button type="button" disabled={!current || busy || session.pending} onClick={checkLinks}>检查当前文档</button>
        </div>
        <div className="workspace-list workspace-results">
          {!current && <p className="workspace-empty">打开工作区内的文档后即可检查本地链接。</p>}
          {issues && <p className="workspace-empty">{issues.length ? issues.length + ' 个问题' : '未发现本地链接问题'}
            {linkLimit && ' · 已检查前 500 项'}</p>}
          {issues?.map((issue, index) => <button type="button" key={index} title={issue.label}
            onClick={() => { if (session.canLeaveInput()) jump.current?.(offsetAtLine(session.currentSource(), issue.line)); }}>
            <span>{issue.label}</span><small>第 {issue.line} 行 · {issue.message}</small>
          </button>)}
        </div>
      </>}
    </>}
    {message && <p className="workspace-message" role="status">{message}</p>}
    {error && !nameEdit && <p className="workspace-message error" role="alert">{error}</p>}
    {menu && menuEntry && root && open && <div className="workspace-menu" ref={menuRef} role="menu"
      aria-label={'操作 ' + menuEntry.name} style={{ left: menu.left, top: menu.top }} onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          closeMenu(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const index = buttons.findIndex(button => button === document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === 'Tab') {
          closeMenu(true);
        }
      }}>
      {menuEntry.document && <>
        <button type="button" role="menuitem" disabled={session.pending} onClick={() => { closeMenu(true); openFile(menuEntry.path); }}>打开</button>
        <button type="button" role="menuitem" disabled={session.pending}
          onClick={() => { closeMenu(true); openFile(menuEntry.path, true); }}>在新窗口打开</button>
      </>}
      {menuEntry.directory && <>
        <button type="button" role="menuitem" onClick={() => { closeMenu(true); toggleFolder(menuEntry.path); }}>
          {expanded.includes(menuEntry.path) ? '折叠文件夹' : '展开文件夹'}</button>
        <button type="button" role="menuitem" disabled={busy || session.pending} onClick={() => {
          closeMenu(true); setError(''); setNameEdit({ kind: 'create', path: menuEntry.path, value: '新建文档.md' });
        }}>在此新建文档</button>
      </>}
      <button type="button" role="menuitem" disabled={busy} onClick={() => {
        closeMenu(true);
        void run(async () => { await navigator.clipboard.writeText(menuEntry.path); setMessage('已复制相对路径。'); }, '无法复制相对路径。');
      }}>复制相对路径</button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => {
        closeMenu(true);
        void run(async () => { await invoke('workspace_reveal', { workspaceId: root.id, relative: menuEntry.path }); }, '无法显示该项目。');
      }}>在文件管理器中显示</button>
      <button type="button" role="menuitem" disabled={busy || session.pending || menuEntry.linked} onClick={() => {
        closeMenu(true); setError(''); setNameEdit({ kind: 'rename', path: menuEntry.path, value: menuEntry.name });
      }}>重命名</button>
      <button type="button" role="menuitem" disabled={busy || session.pending || menuEntry.linked}
        onClick={() => void trashEntry(root, menuEntry)}>移到回收站</button>
    </div>}
    {nameEdit && <dialog ref={nameDialog} className="workspace-name-dialog" onCancel={() => setNameEdit(null)}>
      <form onSubmit={submitName}>
        <label>{nameEdit.kind === 'rename' ? '重命名' : '新建文档'}
          <input autoFocus value={nameEdit.value} maxLength={240} onFocus={event => event.currentTarget.select()}
            onChange={event => setNameEdit({ ...nameEdit, value: event.currentTarget.value })} />
        </label>
        {(error || session.error) && <p className="error" role="alert">{error || session.error}</p>}
        <div><button type="button" disabled={busy} onClick={() => setNameEdit(null)}>取消</button>
          <button type="submit" disabled={busy || session.pending || !nameEdit.value}>确认</button></div>
      </form>
    </dialog>}
  </aside>{confirmation.dialog}</>;
}
