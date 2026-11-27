import { createElement, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, ClipboardEvent, FormEvent } from 'react';
import type { EditorSelection } from '../core/editor-commands';
import type { PreviewInlineText } from '../core/preview-inline-text';
import { createReaderEditSession } from './reader-edit-session';

interface ReaderEditableBlockProps {
  readonly documentKey: string;
  readonly as: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'span';
  readonly blockStart: number;
  readonly sourceText: string;
  readonly allowMultiline?: boolean;
  readonly enabled: boolean;
  readonly initialCaret?: number;
  readonly onCommit: (text: string, inline?: PreviewInlineText, live?: boolean) => boolean;
  readonly onDraftChange: (dirty: boolean) => void;
  readonly onActivityChange: (kind: 'composing' | 'committing', active: boolean) => void;
  readonly onRestricted: (blockStart: number, reason: string, draftText?: string) => void;
  readonly onStart?: () => void;
  readonly onFinish?: () => void;
  readonly onCancel?: () => void;
  readonly onFormatKey?: (event: KeyboardEvent<HTMLElement>) => boolean;
  readonly onSplit?: (text: string, selection: EditorSelection, inline?: PreviewInlineText) => boolean;
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
  readonly tabIndex?: number;
}

function insertPlainText(text: string): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function readerCaretOffset(element: HTMLElement, node: Node, offset: number): number | undefined {
  if (!element.contains(node)) return undefined;
  const prefix = element.ownerDocument.createRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}

function caretRange(element: HTMLElement, offset: number): Range | null {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = element.ownerDocument.createRange();
  let remaining = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (remaining <= text.length) {
      range.setStart(text, remaining);
      range.collapse(true);
      return range;
    }
    remaining -= text.length;
  }
  if (offset !== 0) return null;
  range.setStart(element, 0);
  return range;
}

function previewInlineText(element: HTMLElement | null): PreviewInlineText | undefined {
  if (!element) return undefined;
  const parts: PreviewInlineText[number][] = [];
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const previous = parts.at(-1);
      const text = node.textContent ?? '';
      if (typeof previous === 'string') parts[parts.length - 1] = previous + text;
      else parts.push(text);
      continue;
    }
    if (!(node instanceof HTMLElement)) return undefined;
    const type = node.tagName === 'STRONG' ? 'strong' : node.tagName === 'EM' ? 'emphasis' :
      node.tagName === 'DEL' ? 'delete' : undefined;
    const children = type && previewInlineText(node);
    if (!type || !children) return undefined;
    parts.push({ type, children });
  }
  return parts;
}

/**
 * A deliberately narrow contenteditable surface for one plain Markdown block.
 * It never serializes the rendered article. The owner receives only this
 * block's visible text and maps it back to a proven source range.
 */
export function ReaderEditableBlock({
  documentKey,
  as,
  blockStart,
  sourceText,
  allowMultiline = false,
  enabled,
  initialCaret,
  onCommit,
  onDraftChange,
  onActivityChange,
  onRestricted,
  onStart,
  onFinish,
  onCancel,
  onFormatKey,
  onSplit,
  children,
  className,
  id,
  tabIndex,
}: ReaderEditableBlockProps) {
  // Chromium does not name editable headings from their contents automatically.
  // Refer to the live DOM text so unsaved input is reflected without a stale label.
  const generatedId = useId();
  const headingId = as.startsWith('h') ? id ?? `reader-heading-${generatedId}` : undefined;
  const elementRef = useRef<HTMLElement | null>(null);
  const [restoreVersion, setRestoreVersion] = useState(0);
  const nativeMutationRef = useRef(false);
  const retainedDraftRef = useRef(true);
  const sourceIdentityRef = useRef({ documentKey, as, blockStart, sourceText, id });
  const sessionRef = useRef<ReturnType<typeof createReaderEditSession> | null>(null);
  const callbacks = useRef({ onCommit, onDraftChange, onRestricted, onFinish });
  callbacks.current = { onCommit, onDraftChange, onRestricted, onFinish };
  const caret = useRef<Range | null>(null);
  const captureSelection = () => {
    const element = elementRef.current;
    const selection = window.getSelection();
    if (!element || !selection || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
    return range.cloneRange();
  };
  const captureCaretAtPoint = (event: React.MouseEvent<HTMLElement>) => {
    const point = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    return point && elementRef.current?.contains(point.startContainer) ? point : captureSelection();
  };
  useLayoutEffect(() => {
    const previous = sourceIdentityRef.current;
    const replaced = previous.documentKey !== documentKey || previous.as !== as ||
      previous.blockStart !== blockStart || previous.sourceText !== sourceText || previous.id !== id;
    sourceIdentityRef.current = { documentKey, as, blockStart, sourceText, id };
    // Preserve a draft paused before handoff (for example, a rejected paste).
    // Once handed off, the source/feedback owns its text: restore the rendered
    // children even if disabling disposes this session before its reply arrives.
    // Untouched DOM and its live ranges always stay connected.
    if ((replaced || !retainedDraftRef.current) && nativeMutationRef.current) {
      nativeMutationRef.current = false;
      setRestoreVersion(version => version + 1);
    }
    if (!enabled) return;
    const session = createReaderEditSession({
      sourceText,
      allowMultiline,
      readText: () => elementRef.current?.isConnected ? elementRef.current.textContent ?? '' : null,
      isFocused: () => document.activeElement === elementRef.current,
      restoreChildren: () => {
        nativeMutationRef.current = false;
        setRestoreVersion(version => version + 1);
      },
      onCommit: async text => callbacks.current.onCommit(text, previewInlineText(elementRef.current)),
      onSync: text => callbacks.current.onCommit(text, previewInlineText(elementRef.current), true),
      onDraftChange: dirty => callbacks.current.onDraftChange(dirty),
      onRestricted: (reason, text) => callbacks.current.onRestricted(blockStart, reason, text),
      onFinish: () => callbacks.current.onFinish?.(),
      onCommittingChange: active => onActivityChange('committing', active),
      scheduler: {
        frame: run => { const frame = requestAnimationFrame(run); return () => cancelAnimationFrame(frame); },
        task: run => { const task = window.setTimeout(run, 0); return () => window.clearTimeout(task); },
      },
    });
    sessionRef.current = session;
    const element = elementRef.current;
    if (onStart && element) {
      if (document.activeElement !== element) element.focus({ preventScroll: true });
      const selection = window.getSelection();
      const range = initialCaret === undefined ? caret.current : caretRange(element, initialCaret);
      if (range && element.contains(range.startContainer) && element.contains(range.endContainer)) {
        selection?.removeAllRanges();
        selection?.addRange(range);
      } else {
        selection?.selectAllChildren(element);
        selection?.collapseToEnd();
      }
      caret.current = null;
    }
    // Adopt a paused draft even if disabling moved focus away. Its ownership
    // must survive another pause; this does not move the DOM focus or caret.
    if ((nativeMutationRef.current && retainedDraftRef.current) || document.activeElement === elementRef.current) session.focus();
    return () => {
      retainedDraftRef.current = session.ownsDraft();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [documentKey, as, blockStart, sourceText, allowMultiline, enabled, initialCaret, id, onActivityChange, Boolean(onStart)]);

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (/\r|\n/u.test(text)) {
      onRestricted(blockStart, '多行内容请在源码中粘贴，当前正文未改变。', text);
      return;
    }
    if (insertPlainText(text)) {
      nativeMutationRef.current = true;
      sessionRef.current?.input();
    }
  };

  const split = () => {
    const element = elementRef.current;
    const range = captureSelection();
    if (!element || !range || !onSplit || !sessionRef.current?.canSplit()) return;
    const start = readerCaretOffset(element, range.startContainer, range.startOffset);
    const end = readerCaretOffset(element, range.endContainer, range.endOffset);
    if (start === undefined || end === undefined) return;
    if (!onSplit(element.textContent ?? '', { start, end, direction: range.collapsed ? 'none' : 'forward' }, previewInlineText(element))) {
      onRestricted(blockStart, '当前段落无法安全拆分，请在源码中换行。');
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (sessionRef.current?.composing() || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      elementRef.current?.blur();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (onSplit) split();
      else elementRef.current?.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      sessionRef.current?.restore();
      onCancel?.();
      onFinish?.();
      return;
    }
    if (onFormatKey?.(event)) {
      event.preventDefault();
      return;
    }
  };

  return createElement(as, {
    key: restoreVersion,
    ref: (element: HTMLElement | null) => { elementRef.current = element; },
    id: headingId ?? id,
    'aria-label': sourceText === '' ? '文档正文' : undefined,
    'aria-labelledby': headingId,
    tabIndex,
    className: [className, (enabled || onStart) ? 'reader-editable-block' : undefined].filter(Boolean).join(' ') || undefined,
    contentEditable: enabled ? 'plaintext-only' : false,
    suppressContentEditableWarning: true,
    'data-reader-editable': enabled ? 'true' : undefined,
    'data-source-block-start': blockStart,
    'aria-description': enabled ? (onSplit ? '输入实时同步，按 Enter 拆分段落，按 Escape 退出编辑'
      : '输入实时同步，按 Enter 或 Escape 退出编辑') : onStart ? '点击文字或按 Enter 开始编辑' : undefined,
    onClick: !enabled && onStart ? (event: React.MouseEvent<HTMLElement>) => {
      // A drag selection remains a normal reading selection. A single click
      // with a collapsed caret enters editing at the point the user clicked.
      if (event.detail !== 1 || event.defaultPrevented) return;
      if (window.getSelection()?.isCollapsed === false) return;
      caret.current = captureCaretAtPoint(event);
      onStart();
    } : undefined,
    onDoubleClick: !enabled && onStart ? () => {
      // The first click has already activated the block. If activation was
      // suppressed by a non-collapsed selection, preserve the browser's word
      // selection from the double-click before enabling contenteditable.
      caret.current = captureSelection() ?? caret.current;
      onStart();
    } : undefined,
    onFocus: enabled ? () => sessionRef.current?.focus() : undefined,
    onCompositionStart: enabled ? () => {
      nativeMutationRef.current = true;
      sessionRef.current?.compositionStart();
      onActivityChange('composing', true);
    } : undefined,
    onCompositionEnd: enabled ? () => {
      sessionRef.current?.compositionEnd();
      onActivityChange('composing', false);
    } : undefined,
    onBeforeInput: (event: FormEvent<HTMLElement>) => {
      if (!enabled) { event.preventDefault(); return; }
      const inputType = (event.nativeEvent as InputEvent).inputType ?? '';
      if (!sessionRef.current?.composing() && (inputType === 'insertParagraph' || inputType === 'insertLineBreak' || inputType.startsWith('format'))) {
        event.preventDefault();
        if (inputType.startsWith('format')) onRestricted(blockStart, '这项格式操作请使用选文菜单，或在源码中继续。');
        else if (onSplit) split();
        else elementRef.current?.blur();
      }
    },
    onInput: enabled ? () => {
      nativeMutationRef.current = true;
      sessionRef.current?.input();
    } : undefined,
    onPaste: enabled ? handlePaste : undefined,
    onKeyDown: enabled ? handleKeyDown : onStart ? (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      onStart();
    } : undefined,
    onBlur: () => sessionRef.current?.blur(),
  }, children);
}
