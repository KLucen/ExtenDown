import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, insertNewline, isolateHistory } from '@codemirror/commands';
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { type EditorCommandId, type EditorSelection as SourceSelection, type ShortcutOverrides, type SourcePatch } from '../core/editor-commands.ts';
import { markdownToEditorText } from '../core/editor-text.ts';
import { SourceCommandMenu, SourceSelectionToolbar, type SourceMenuPosition } from './source-command-menu.tsx';

export type { SourceSelection };
export interface SourceSurfaceHandle {
  focus(): void;
  text(): string;
  lineCount(): number;
  offsetForLine(line: number): number | null;
  composing(): boolean;
  selection(): SourceSelection;
  select(selection: SourceSelection, reveal?: boolean): void;
  replaceText(value: string): boolean;
  applyPatch(patch: SourcePatch, expectedSource?: string): boolean;
}
interface Props {
  readonly documentKey: string;
  readonly documentName: string;
  readonly value: string;
  readonly readOnly: boolean;
  readonly softWrap?: boolean;
  readonly onChange: (value: string, selection: SourceSelection) => void;
  readonly onSelect: (selection: SourceSelection) => void;
  readonly onActivityChange?: (kind: 'committing', active: boolean) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onCommand?: (id: EditorCommandId) => void;
  readonly shortcuts?: ShortcutOverrides;
  readonly additionalFenceLanguages?: readonly string[];
}
function selection(view: EditorView): SourceSelection {
  const { anchor, head, from, to } = view.state.selection.main;
  return { start: from, end: to, direction: anchor === head ? 'none' : anchor < head ? 'forward' : 'backward' };
}

function editorSelection(start: number, end: number, direction: SourceSelection['direction']) {
  return direction === 'backward' ? EditorSelection.single(end, start) : EditorSelection.single(start, end);
}

function applyPatch(view: EditorView, patch: SourcePatch, expectedSource?: string): boolean {
  const doc = view.state.doc;
  const { start, end, expected, selection } = patch;
  if (view.state.readOnly || view.compositionStarted || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end > doc.length || doc.sliceString(start, end) !== expected ||
      (expectedSource !== undefined && expectedSource !== doc.toString())) return false;
  const insert = markdownToEditorText(patch.insert);
  const length = doc.length - (end - start) + insert.length;
  if (selection && (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) ||
      selection.start < 0 || selection.end < selection.start || selection.end > length)) return false;
  view.dispatch({
    changes: insert === expected ? undefined : { from: start, to: end, insert },
    selection: selection && editorSelection(selection.start, selection.end, selection.direction),
    annotations: isolateHistory.of('full'),
  });
  return true;
}

const markdownSyntax = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '650' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.url, tags.link], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [tags.monospace, tags.labelName], color: 'var(--syntax-string, #246441)' },
  { tag: [tags.quote, tags.comment, tags.processingInstruction], color: 'var(--syntax-comment, var(--text-muted))' },
  { tag: [tags.contentSeparator, tags.atom], color: 'var(--syntax-keyword, #805278)' },
]));

const baseFenceLanguages = ['bash', 'css', 'html', 'javascript', 'json', 'python', 'rust', 'sql', 'typescript', 'xml'];

function fenceCompletions(context: CompletionContext, extra: readonly string[] = []) {
  if (context.state.readOnly) return null;
  const line = context.state.doc.lineAt(context.pos);
  const match = line.text.match(/^([ \t>]*(?:`{3,}|~{3,})[ \t]*)([\w+-]*)$/u);
  if (!match || context.pos !== line.to || (!match[2] && !context.explicit)) return null;
  const node = syntaxTree(context.state).resolve(context.pos, -1);
  const fence = node.name === 'FencedCode' ? node : node.parent;
  if (fence?.name !== 'FencedCode' || fence.from >= line.to || fence.from < line.from) return null;
  return {
    from: line.from + match[1].length,
    options: [...baseFenceLanguages, ...extra].map(label => ({ label, type: 'keyword' })),
    validFor: /^[\w+-]*$/u,
  };
}

function contextBlock(view: EditorView): SourceMenuPosition['block'] {
  const head = view.state.selection.main.head;
  const tree = syntaxTree(view.state);
  for (const bias of [-1, 1] as const) {
    for (let node = tree.resolve(head, bias); node; ) {
      const name = node.name === 'FencedCode' || node.name === 'CodeBlock' ? '代码块' : node.name === 'Table' ? '表格' : null;
      if (name) return { name, selection: { start: node.from, end: node.to, direction: 'forward' } };
      if (!node.parent) break;
      node = node.parent;
    }
  }
  return undefined;
}

// The full LF source stays in EditorState. Only its visible lines are mounted;
// Markdown interpretation and all persistence remain outside this component.
export const SourceSurface = forwardRef<SourceSurfaceHandle, Props>(function SourceSurface(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props); latest.current = props;
  const text = useRef(props.value);
  const publishedText = useRef(props.value);
  const compositionActive = useRef(false);
  const cancelComposition = useRef<(() => void) | null>(null);
  const readonly = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const wrapped = useRef(Boolean(props.softWrap));
  const syncing = useRef(false);
  const toolbarMeasureKey = useRef({});
  const [menu, setMenu] = useState<SourceMenuPosition | null>(null);
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | null>(null);

  function measureToolbar(view: EditorView) {
    view.requestMeasure({ key: toolbarMeasureKey.current, read: () => {
      const range = view.state.selection.main;
      if (range.empty || !view.hasFocus || view.state.readOnly || compositionActive.current || !latest.current.onCommand) return null;
      const coords = view.coordsAtPos(range.head, range.head === range.to ? -1 : 1);
      const visible = view.scrollDOM.getBoundingClientRect();
      return coords && coords.top >= visible.top - 1 && coords.bottom <= visible.bottom + 1 ? { x: coords.left, y: coords.top } : null;
    }, write: value => setToolbar(value) });
  }

  function showMenu(x: number, y: number) {
    const view = editor.current;
    if (!view || !latest.current.onCommand || compositionActive.current || view.compositionStarted) return false;
    setMenu({ x, y, block: contextBlock(view) });
    return true;
  }

  function closeMenu(restoreFocus: boolean) {
    setMenu(null);
    if (restoreFocus) editor.current?.focus();
  }

  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    text: () => text.current,
    lineCount: () => editor.current?.state.doc.lines ?? 1,
    composing: () => compositionActive.current,
    offsetForLine: line => {
      const document = editor.current?.state.doc;
      return document && Number.isSafeInteger(line) && line >= 1 && line <= document.lines ? document.line(line).from : null;
    },
    selection: () => editor.current ? selection(editor.current) : { start: 0, end: 0, direction: 'none' },
    replaceText: value => {
      const view = editor.current;
      if (!view || compositionActive.current) return false;
      const insert = markdownToEditorText(value);
      const previous = selection(view);
      return applyPatch(view, { start: 0, end: view.state.doc.length, expected: view.state.doc.toString(), insert,
        selection: { start: Math.min(previous.start, insert.length), end: Math.min(previous.end, insert.length), direction: previous.direction } });
    },
    applyPatch: (patch, expectedSource) => !!editor.current && !compositionActive.current && applyPatch(editor.current, patch, expectedSource),
    select: (next, reveal) => {
      const view = editor.current;
      if (!view || compositionActive.current) return;
      const start = Math.min(Math.max(0, next.start), view.state.doc.length);
      const end = Math.min(Math.max(start, next.end), view.state.doc.length);
      view.dispatch({ selection: editorSelection(start, end, next.direction),
        ...(reveal ? { effects: EditorView.scrollIntoView(start, { y: 'center' }) } : {}) });
    },
  }), []);

  useLayoutEffect(() => {
    const current = latest.current;
    setMenu(null);
    setToolbar(null);
    text.current = current.value;
    publishedText.current = current.value;
    wrapped.current = Boolean(current.softWrap);
    let alive = true;
    let composing = false;
    let finishGeneration = 0;
    const finishMeasureKey = {};
    const setCompositionActive = (active: boolean) => {
      if (compositionActive.current === active) return;
      compositionActive.current = active;
      if (active) { setMenu(null); setToolbar(null); }
      latest.current.onActivityChange?.('committing', active);
    };
    const publish = (view: EditorView) => {
      text.current = view.state.doc.toString();
      if (publishedText.current === text.current) latest.current.onSelect(selection(view));
      else {
        publishedText.current = text.current;
        latest.current.onChange(text.current, selection(view));
      }
    };
    const finishComposition = (view: EditorView) => {
      finishGeneration++;
      if (!alive || editor.current !== view || !compositionActive.current) return;
      composing = false;
      try { publish(view); }
      finally { setCompositionActive(false); }
    };
    const cancel = () => {
      finishGeneration++;
      composing = false;
      setCompositionActive(false);
    };
    cancelComposition.current = cancel;
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: current.value, extensions: [
      // No local history: all modes use the owner's single transaction history.
      markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false, pasteURLAsLink: false }),
      markdownSyntax,
      autocompletion({ override: [context => compositionActive.current ? null : fenceCompletions(context, latest.current.additionalFenceLanguages)] }),
      keymap.of([{ key: 'Enter', run: insertNewlineContinueMarkup }, { key: 'Enter', run: insertNewline }, ...defaultKeymap]),
      EditorState.tabSize.of(4), readonly.current.of(EditorState.readOnly.of(current.readOnly)),
      wrapping.current.of(current.softWrap ? EditorView.lineWrapping : []),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码', 'data-source-input': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
      EditorView.domEventObservers({
        scroll: (_event, view) => measureToolbar(view),
        compositionstart: (_event, view) => {
          if (!composing && compositionActive.current) finishComposition(view);
          finishGeneration++;
          composing = true;
          setCompositionActive(true);
        },
        compositionend: (_event, view) => {
          composing = false;
          const generation = ++finishGeneration;
          // Normal measurement flushes CodeMirror's DOM observer first. Read
          // the latest state after measurement exits, never a captured candidate.
          view.requestMeasure({ key: finishMeasureKey, read: () => generation,
            write: token => queueMicrotask(() => {
              if (alive && editor.current === view && token === finishGeneration &&
                  compositionActive.current && !composing && !view.compositionStarted) finishComposition(view);
            }) });
        },
        keydown: (event, view) => {
          // CodeMirror flushes pending DOM changes before ordinary keydown,
          // but explicitly excludes the IME's 229 key.
          if (!composing && compositionActive.current && !view.compositionStarted &&
              !event.isComposing && event.keyCode !== 229) finishComposition(view);
        },
      }),
      EditorView.domEventHandlers({ keydown: event => {
        // An IME confirmation arriving after compositionend must not reach
        // ordinary bindings such as Enter while final text is still pending.
        return compositionActive.current && (event.isComposing || event.keyCode === 229);
      } }),
      EditorView.updateListener.of(update => {
        if (update.selectionSet || update.focusChanged || update.geometryChanged || update.docChanged) measureToolbar(update.view);
        if (syncing.current) return;
        if (update.docChanged) {
          text.current = update.state.doc.toString();
          if (!compositionActive.current) publish(update.view);
        } else if (update.selectionSet && !compositionActive.current) latest.current.onSelect(selection(update.view));
      }),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'inherit', fontSize: 'inherit', lineHeight: '1.65', overflow: 'auto' },
        '.cm-content': { padding: '18px 0' }, '.cm-line': { padding: '0 20px' }, '&.cm-focused': { outline: 'none' },
        '.cm-tooltip-autocomplete': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--line)' },
        '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--surface-muted)', color: 'var(--text)' } }),
    ] }) });
    editor.current = view;
    return () => {
      alive = false;
      cancel();
      cancelComposition.current = null;
      editor.current = null;
      view.destroy();
    };
  }, [props.documentKey]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    syncing.current = true;
    try {
      const effects = view.state.facet(EditorState.readOnly) !== props.readOnly
        ? readonly.current.reconfigure(EditorState.readOnly.of(props.readOnly)) : [];
      if (publishedText.current !== props.value) {
        cancelComposition.current?.();
        const { anchor, head } = view.state.selection.main;
        text.current = props.value;
        publishedText.current = props.value;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, effects,
          selection: EditorSelection.single(Math.min(anchor, props.value.length), Math.min(head, props.value.length)) });
      } else if (!Array.isArray(effects)) view.dispatch({ effects });
      view.contentDOM.setAttribute('aria-readonly', String(props.readOnly));
    } finally { syncing.current = false; }
  }, [props.value, props.readOnly, props.documentKey]);

  useLayoutEffect(() => {
    const next = Boolean(props.softWrap);
    if (!editor.current || wrapped.current === next) return;
    wrapped.current = next;
    editor.current.dispatch({ effects: wrapping.current.reconfigure(next ? EditorView.lineWrapping : []) });
  }, [props.softWrap, props.documentKey]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const view = editor.current;
    if (view && event.shiftKey && event.key === 'F10' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const coords = view.coordsAtPos(view.state.selection.main.head);
      const area = view.dom.getBoundingClientRect();
      if (showMenu(coords?.left ?? area.left + 12, coords?.bottom ?? area.top + 12)) { event.preventDefault(); return; }
    }
    props.onKeyDown?.(event);
  }

  function rightClick(event: MouseEvent<HTMLDivElement>) {
    const view = editor.current;
    if (!view || !props.onCommand || compositionActive.current || view.compositionStarted) { props.onContextMenu?.(event); return; }
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const range = view.state.selection.main;
    if (at !== null && (at < range.from || at > range.to)) view.dispatch({ selection: { anchor: at } });
    if (showMenu(event.clientX, event.clientY)) event.preventDefault();
  }

  return <>
    <div ref={host} className="source-editor-surface" data-source-editor="true" data-source-wrap={Boolean(props.softWrap)} title={props.documentName}
      onKeyDown={keyDown} onContextMenu={rightClick} />
    {props.onCommand && !props.readOnly && !menu && toolbar && <SourceSelectionToolbar position={toolbar} onCommand={props.onCommand}
      onMore={position => showMenu(position.x, position.y)} />}
    {props.onCommand && menu && editor.current && <SourceCommandMenu position={menu} selection={selection(editor.current)}
      readOnly={props.readOnly} shortcuts={props.shortcuts ?? {}} onCommand={props.onCommand} onClose={closeMenu}
      onBlock={(range, copy) => {
        const view = editor.current;
        if (!view || range.end > view.state.doc.length) return;
        view.dispatch({ selection: editorSelection(range.start, range.end, range.direction) });
        if (copy) props.onCommand?.('edit.copy');
      }} />}
  </>;
});
