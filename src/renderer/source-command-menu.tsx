import { useEffect, useLayoutEffect, useRef } from 'react';
import { EDITOR_COMMANDS, shortcutLabel, type EditorCommandId, type EditorSelection, type ShortcutOverrides } from '../core/editor-commands.ts';

interface Point { readonly x: number; readonly y: number }
export interface SourceMenuPosition extends Point {
  readonly block?: { readonly name: '代码块' | '表格'; readonly selection: EditorSelection };
}

const groups = [
  ['剪贴板', ['edit.cut', 'edit.copy', 'edit.paste']],
  ['格式', ['format.bold', 'format.italic', 'format.link', 'format.strike', 'format.inline-code']],
  ['段落', ['paragraph.heading', 'paragraph.quote', 'paragraph.bullet', 'paragraph.task']],
  ['插入', ['insert.code', 'insert.table', 'insert.math', 'insert.mermaid']],
] as const;

export function SourceCommandMenu({ position, selection, readOnly, shortcuts, onCommand, onBlock, onClose }: {
  readonly position: SourceMenuPosition;
  readonly selection: EditorSelection;
  readonly readOnly: boolean;
  readonly shortcuts: ShortcutOverrides;
  readonly onCommand: (id: EditorCommandId) => void;
  readonly onBlock: (selection: EditorSelection, copy: boolean) => void;
  readonly onClose: (restoreFocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(6, Math.min(position.x, window.innerWidth - width - 6))}px`;
    element.style.top = `${Math.max(6, Math.min(position.y, window.innerHeight - height - 6))}px`;
    (element.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? element).focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    function outside(event: Event) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose(false);
    }
    function resize() { onClose(false); }
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', outside, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', outside, true);
    };
  }, [onClose]);

  const block = position.block;
  const mac = /Macintosh|Mac OS X/u.test(navigator.userAgent);
  const empty = selection.start === selection.end;
  return <div ref={menu} className="source-command-menu" role="menu" aria-label="源码编辑操作" tabIndex={-1}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); onClose(true); return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }}>
    {block && <div role="group" aria-label={block.name}>
      <small aria-hidden="true">{block.name}</small>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { onClose(true); onBlock(block.selection, false); }}>选择{block.name}</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { onClose(true); onBlock(block.selection, true); }}>复制{block.name}源码</button>
    </div>}
    {groups.map(([label, ids]) => <div role="group" key={label} aria-label={label}>
      <small aria-hidden="true">{label}</small>
      {ids.map(id => <button type="button" role="menuitem" key={id} tabIndex={-1}
        disabled={id === 'edit.copy' ? empty : readOnly || (id === 'edit.cut' && empty)} onClick={() => { onClose(true); onCommand(id); }}>
        {EDITOR_COMMANDS[id].label}<kbd>{shortcutLabel(EDITOR_COMMANDS[id], shortcuts, mac)}</kbd>
      </button>)}
    </div>)}
  </div>;
}

export function SourceSelectionToolbar({ position, onCommand, onMore, label = '源码选区操作' }: {
  readonly position: Point;
  readonly onCommand: (id: EditorCommandId) => void;
  readonly onMore: (position: Point) => void;
  readonly label?: string;
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(6, Math.min(position.x, window.innerWidth - width - 6))}px`;
    element.style.top = `${position.y - height >= 42 ? position.y - height : Math.min(position.y + 26, window.innerHeight - height - 6)}px`;
  }, [position]);

  return <div ref={toolbar} className="source-command-toolbar" role="toolbar" aria-label={label}
    onPointerDown={event => event.preventDefault()}>
    <button type="button" onClick={() => onCommand('format.bold')}>粗体</button>
    <button type="button" onClick={() => onCommand('format.italic')}>斜体</button>
    <button type="button" onClick={() => onCommand('format.link')}>链接</button>
    <button type="button" aria-haspopup="menu" onClick={event => {
      const { left, bottom } = event.currentTarget.getBoundingClientRect();
      onMore({ x: left, y: bottom + 4 });
    }}>更多</button>
  </div>;
}
