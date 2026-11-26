import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  commandShortcut, EDITOR_COMMANDS, matchesCommand, shortcutConflict, shortcutForKey, shortcutLabel, validShortcut,
  type CommandDescription, type EditorCommand, type EditorSelection, type ShortcutOverrides, type SourcePatch,
} from '../core/editor-commands.ts';
import { findEditorTextMatches, replaceAllEditorText } from '../core/editor-text.ts';
import './commands.css';

const STORAGE_KEY = 'extendown.shortcuts.v1';
const coreCommands = Object.values(EDITOR_COMMANDS);

function readShortcuts(mac: boolean, additional: readonly CommandDescription[] = []): ShortcutOverrides {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return {};
    const stored = raw as Record<string, unknown>;
    const result: Record<string, string | null> = {};
    const known = [...coreCommands, ...additional.filter(command => !Object.hasOwn(EDITOR_COMMANDS, command.id))];
    const additionalIds = Object.keys(stored).filter(id => id.length <= 207 && /^plugin:[a-z][a-z\d]*(?:[.-][a-z\d]+)*$/u.test(id) &&
      !known.some(command => command.id === id))
      .map(id => ({ id, label: id, category: '插件', scope: 'app' as const }));
    const commands = [...known, ...additionalIds];
    for (const { id } of commands) {
      const key = stored[id];
      if (key === null || (typeof key === 'string' && validShortcut(key))) result[id] = key;
    }
    // Validate with the complete set of overrides. A custom shortcut can reuse
    // another command's old default when that command moved to a new key.
    for (;;) {
      const invalid = Object.entries(result).filter(([id, key]) => key && shortcutConflict(key, id, commands, result, mac));
      if (!invalid.length) return result;
      for (const [id] of invalid) delete result[id];
    }
  } catch { return {}; }
}

export function useShortcuts() {
  const mac = /Macintosh|Mac OS X/u.test(navigator.userAgent);
  const [overrides, setOverrides] = useState(() => readShortcuts(mac));
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === STORAGE_KEY || event.key === null) setOverrides(readShortcuts(mac));
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [mac]);

  function persist(next: ShortcutOverrides) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch { return '无法存储快捷键设置。'; }
    setOverrides(next);
    return null;
  }

  function setShortcut(id: string, key: string | null | undefined, additional: readonly CommandDescription[] = []) {
    const commands = [...coreCommands, ...additional.filter(command => !Object.hasOwn(EDITOR_COMMANDS, command.id))];
    const description = commands.find(command => command.id === id);
    if (!description) return '此命令尚不支持自定义快捷键。';
    const current = readShortcuts(mac, additional);
    const candidate = key === undefined ? commandShortcut(description, {}, mac) : key;
    const error = candidate && shortcutConflict(candidate, id, commands, current, mac);
    if (error) return error;
    const next = { ...current };
    if (key === undefined) delete next[id];
    else next[id] = key;
    return persist(next);
  }

  return { overrides, mac, setShortcut, resetAll: () => persist({}) };
}

type Shortcuts = ReturnType<typeof useShortcuts>;

export function useCommandShortcuts({ commands, shortcuts, blocked, canRun }: {
  readonly commands: readonly EditorCommand[];
  readonly shortcuts: Shortcuts;
  readonly blocked: boolean;
  readonly canRun?: (event: KeyboardEvent, command: EditorCommand) => boolean;
}) {
  const latest = useRef({ commands, shortcuts, blocked, canRun });
  latest.current = { commands, shortcuts, blocked, canRun };
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const { commands, shortcuts, blocked, canRun } = latest.current;
      if (blocked || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const key = shortcutForKey(event, shortcuts.mac);
      if (!key) return;
      const command = commands.find(item => commandShortcut(item, shortcuts.overrides, shortcuts.mac) === key ||
        (item.id === 'edit.redo' && !shortcuts.mac && key === 'Mod+Shift+Z' && !Object.hasOwn(shortcuts.overrides, item.id)));
      if (!command) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-shortcut-capture="true"]')) return;
      if (!canRun && command.scope === 'source' && !target?.closest('[data-source-input]')) return;
      if (canRun && !canRun(event, command)) return;
      event.preventDefault();
      if (command.enabled !== false && !event.repeat) command.run();
    }
    // The source editor also handles native editing keys. Dispatch this registry
    // first so a user binding works consistently even on an editor surface.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

export function CommandPalette({ commands, shortcuts, onClose }: {
  readonly commands: readonly EditorCommand[];
  readonly shortcuts: Shortcuts;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const filtered = commands.filter(command => matchesCommand(command, query));
  const active = Math.min(selected, Math.max(0, filtered.length - 1));

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    search.current?.focus();
  }, []);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);

  function close() {
    dialog.current?.close();
    onClose();
  }

  function run(command: EditorCommand | undefined) {
    if (!command || command.enabled === false) return;
    close();
    command.run();
  }

  function navigate(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (filtered.length) setSelected((active + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length);
        break;
      case 'Enter': event.preventDefault(); run(filtered[active]); break;
      default: break;
    }
  }

  return <dialog ref={dialog} className="command-palette" aria-labelledby="command-palette-title" onCancel={event => {
    event.preventDefault();
    close();
  }}>
    <div className="modal-head">
      <h2 id="command-palette-title">命令面板</h2>
      <button type="button" aria-label="关闭命令面板" onClick={close}>×</button>
    </div>
    <div className="command-palette-search">
      <input ref={search} type="search" role="combobox" aria-label="搜索命令" placeholder="搜索命令"
        aria-controls="command-palette-results" aria-expanded="true" aria-autocomplete="list"
        aria-activedescendant={filtered.length ? `command-option-${active}` : undefined} value={query}
        onChange={event => { setQuery(event.target.value); setSelected(0); }} onKeyDown={navigate} />
    </div>
    <div ref={list} id="command-palette-results" className="command-palette-results" role="listbox" aria-label="命令结果">
      {filtered.map((command, index) => <button type="button" role="option" tabIndex={-1} key={command.id}
        id={`command-option-${index}`} aria-selected={index === active} aria-disabled={command.enabled === false}
        data-active={index === active} onPointerMove={() => setSelected(index)} onClick={() => run(command)}>
        <span>{command.label}<small>{command.category} · {command.source ?? '内置'}</small></span>
        <kbd>{shortcutLabel(command, shortcuts.overrides, shortcuts.mac)}</kbd>
      </button>)}
    </div>
    {!filtered.length && <p className="command-empty" role="status">没有匹配的命令</p>}
  </dialog>;
}

export function ShortcutSettings({ shortcuts, commands = coreCommands }: {
  readonly shortcuts: Shortcuts;
  readonly commands?: readonly Pick<EditorCommand, 'id' | 'label' | 'category' | 'scope' | 'aliases' | 'source' | 'defaultShortcut'>[];
}) {
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState('');
  const filtered = commands.filter(command => matchesCommand(command, query));

  function update(id: string, key: string | null | undefined) {
    const error = shortcuts.setShortcut(id, key, commands);
    setError(error ?? '');
    if (!error) setRecording(null);
  }

  return <section className="settings-section shortcut-settings" aria-label="快捷键">
    <div className="shortcut-settings-header">
      <input type="search" aria-label="搜索快捷键" placeholder="搜索命令" value={query}
        onChange={event => setQuery(event.target.value)} />
      <button className="setting-action" type="button" onClick={() => { setRecording(null); setError(shortcuts.resetAll() ?? ''); }}>恢复全部默认</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {!filtered.length && <p role="status">没有匹配的命令</p>}
    {filtered.map(command => <div className="shortcut-settings-row" key={command.id}>
      <span>{command.label}<small>{command.category}</small></span>
      <button type="button" className="setting-action" aria-label={`修改${command.label}快捷键`} aria-pressed={recording === command.id}
        data-shortcut-capture="true"
        onBlur={() => setRecording(value => value === command.id ? null : value)}
        onClick={() => { setError(''); setRecording(command.id); }} onKeyDown={event => {
          if (recording !== command.id || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Tab') return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') { setRecording(null); setError(''); return; }
          const key = shortcutForKey(event.nativeEvent, shortcuts.mac);
          if (key) update(command.id, key);
        }}>
        {recording === command.id ? '按下新快捷键' : shortcutLabel(command, shortcuts.overrides, shortcuts.mac) || '未设置'}
      </button>
      <button type="button" className="setting-action" aria-label={`清除${command.label}快捷键`}
        disabled={!commandShortcut(command, shortcuts.overrides, shortcuts.mac)} onClick={() => update(command.id, null)}>清除</button>
      <button type="button" className="setting-action" aria-label={`恢复${command.label}快捷键`}
        disabled={!Object.hasOwn(shortcuts.overrides, command.id)} onClick={() => update(command.id, undefined)}>重置</button>
    </div>)}
  </section>;
}

export interface EditorSearchProps {
  readonly mode: 'find' | 'replace';
  readonly source: string;
  readonly selection: EditorSelection;
  readonly readSource: () => string;
  readonly onSelect: (start: number, end: number) => void;
  readonly onPatch: (patch: SourcePatch, expectedSource: string) => boolean;
  readonly onReplaceAll: (value: string, expectedSource: string) => boolean;
  readonly readOnly: boolean;
  readonly onClose: () => void;
  readonly onModeChange?: (mode: 'find' | 'replace') => void;
}

export function EditorSearch({ mode, source, selection, readSource, onSelect, onPatch, onReplaceAll, readOnly, onClose, onModeChange }: EditorSearchProps) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [message, setMessage] = useState('');
  const matches = useMemo(() => findEditorTextMatches(source, query), [source, query]);
  const current = matches.findIndex(match => match.start === selection.start && match.end === selection.end);
  const status = !query ? '' : matches.length ? `${current >= 0 ? `${current + 1} / ` : ''}${matches.length}${matches.length === 10_000 ? '+' : ''} 处匹配` : '无匹配';

  useEffect(() => { input.current?.focus(); }, [mode]);

  function findMatch(text: string, previous: boolean) {
    if (!query) return null;
    let start = previous ? (selection.start >= query.length ? text.lastIndexOf(query, selection.start - query.length) : -1)
      : text.indexOf(query, selection.end);
    if (start < 0) start = previous ? text.lastIndexOf(query) : text.indexOf(query);
    return start < 0 ? null : { start, end: start + query.length };
  }

  function find(previous: boolean) {
    const match = findMatch(readSource(), previous);
    setMessage('');
    if (match) onSelect(match.start, match.end);
  }

  function replaceOne() {
    const live = readSource();
    const match = live === source && live.slice(selection.start, selection.end) === query && query ? selection : findMatch(live, false);
    if (!match) return;
    const end = match.start + replacement.length;
    if (!onPatch({ ...match, expected: query, insert: replacement, selection: { start: end, end, direction: 'none' } }, live)) {
      setMessage('暂时无法替换，请结束当前输入后重试。');
      return;
    }
    setMessage('已替换 1 处');
  }

  function replaceAll() {
    const live = readSource();
    const result = replaceAllEditorText(live, query, replacement);
    if (result.count && !onReplaceAll(result.text, live)) {
      setMessage('暂时无法替换，请结束当前输入后重试。');
      return;
    }
    setMessage(`已替换 ${result.count} 处`);
  }

  return <form className="search-bar command-search-bar" aria-label={mode === 'replace' ? '查找替换' : '查找'}
    onSubmit={event => { event.preventDefault(); find(false); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); find(true); }
    }}>
    <input ref={input} id="editor-search-query" aria-label="查找源码文字" placeholder="查找源码文字" value={query}
      onChange={event => { setQuery(event.target.value); setMessage(''); }} />
    <button type="button" disabled={!matches.length} onClick={() => find(true)}>上一处</button>
    <button type="submit" disabled={!matches.length}>下一处</button>
    {onModeChange && <button type="button" aria-pressed={mode === 'replace'} onClick={() => onModeChange(mode === 'replace' ? 'find' : 'replace')}>替换</button>}
    <span className="command-search-status" role="status">{message || status}</span>
    <button className="command-search-close" type="button" aria-label="关闭查找" onClick={onClose}>×</button>
    {mode === 'replace' && <div className="command-search-replace">
      <input aria-label="替换为" placeholder="替换为" value={replacement} onChange={event => { setReplacement(event.target.value); setMessage(''); }} />
      <button type="button" disabled={readOnly || !matches.length} onClick={replaceOne}>替换一处</button>
      <button type="button" disabled={readOnly || !matches.length} onClick={replaceAll}>全部替换</button>
    </div>}
  </form>;
}
