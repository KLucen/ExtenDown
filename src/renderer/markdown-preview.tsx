import { createContext, createElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import type { Element, Root } from 'hast';
import { buildPreviewProjection, resolvePreviewFragment } from '../core/preview-projection.ts';
import { hasMermaidExtension, MAX_MERMAID_DIAGRAMS, mermaidSource } from '../core/plugins/mermaid.ts';
import { hasMathExtension, READING_EXTENSION_CSS, type ReadingOptions } from '../core/plugins/reading-extensions.ts';
import {
  buildPreviewFormatPatch, buildPreviewTextPatch, collectPreviewEdits, PREVIEW_FORMAT_COMMANDS, type EditablePreviewTable,
  type PreviewFormatCommand,
  type PreviewSourcePatch, type PreviewSourceSpan,
} from '../core/preview-edit.ts';
import { EDITOR_COMMANDS, commandShortcut, shortcutForKey, type EditorSelection, type ShortcutOverrides } from '../core/editor-commands.ts';
import { ReaderEditableBlock } from './reader-editable-block';
import { ReaderMarkdown } from './reader-markdown';
import { PreviewTableEditor } from './preview-table-editor';
import { PreviewCodeBlock } from './preview-code-block';
import { SourceSelectionToolbar } from './source-command-menu';
import './preview-edit.css';

const extensionLabels = {
  'display-math': '数学公式',
  'wiki-link': 'Wiki 链接',
  directive: '指令语法',
} as const;

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
type HeadingProps = ComponentProps<'h1'> & ExtraProps;

type ImageResolver = (reference: string) => Promise<string | null>;

interface PreviewVersion {
  readonly documentKey: string;
  readonly revision: number;
}

export type PreviewSourceRange = PreviewVersion & PreviewSourceSpan;
interface PreviewPatch extends PreviewSourcePatch {
  readonly selection?: EditorSelection;
  readonly revealSource?: boolean;
}
export type PreviewRangeEdit = PreviewVersion & PreviewPatch;
type PreviewActivity = 'composing' | 'committing' | 'draft';

export interface PreviewEditing extends PreviewVersion {
  readonly writable: boolean;
  readonly current: boolean;
  readonly onEdit: (request: PreviewRangeEdit) => boolean;
  readonly onOpenSource: (range: PreviewSourceRange) => boolean;
  readonly shortcuts?: ShortcutOverrides;
  readonly onActivityChange: (kind: PreviewActivity, active: boolean) => void;
}

interface ActiveText extends PreviewVersion {
  readonly offset: number;
  readonly initialCaret?: number;
  readonly source: string;
  readonly reading: ReadingOptions;
}

interface PreviewTextPress {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly documentKey: string;
  readonly text: string;
  readonly caret: number;
  readonly activeOffset: number;
  offset: number;
  source: string;
  released: boolean;
}

interface PreviewEditControls {
  readonly documentKey: string;
  readonly revision: number;
  readonly ready: boolean;
  readonly activeText: ActiveText | null;
  readonly canFormat: () => boolean;
  readonly focusBlock: (offset: number) => void;
  readonly math: boolean;
  readonly shortcuts?: ShortcutOverrides;
  readonly startText: (offset: number) => void;
  readonly finishText: (offset: number) => void;
  readonly commitText: (offset: number, previous: string, next: string) => Promise<boolean>;
  readonly setDraft: (dirty: boolean) => void;
  readonly setActivity: (kind: PreviewActivity, active: boolean) => void;
  readonly report: (offset: number, reason: string, draft?: string) => void;
  readonly apply: (patch: PreviewPatch, version: PreviewVersion) => boolean;
  readonly openSource: (span: PreviewSourceSpan) => void;
  readonly openTable: (table: EditablePreviewTable) => void;
}

const PreviewEditContext = createContext<PreviewEditControls | null>(null);
const TaskSpanContext = createContext<PreviewSourcePatch | undefined>(undefined);

function PreviewText({ as, offset, text, children, ...props }: HeadingProps & {
  readonly as: 'p' | HeadingTag;
  readonly offset?: number;
  readonly text?: string;
}) {
  const controls = useContext(PreviewEditContext);
  const active = Boolean(controls?.activeText && controls.activeText.offset === offset);
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | null>(null);
  const [showMore, setShowMore] = useState(false);
  useEffect(() => {
    if (!active) {
      setToolbar(null);
      setShowMore(false);
      return;
    }
    const update = () => {
      const selected = activePreviewSelection(offset);
      const rect = selected && !selected.range.collapsed ? selected.range.getBoundingClientRect() : null;
      setToolbar(rect && rect.width ? { x: rect.left, y: rect.top } : null);
    };
    update();
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [active, offset]);
  const available = controls && offset !== undefined && text !== undefined;
  if (!available) {
    const Tag = as;
    return <Tag {...props}>{children}</Tag>;
  }
  const runFormat = (command: PreviewFormatCommand) => {
    const current = controls.activeText;
    const selected = activePreviewSelection(offset);
    if (!current || !selected || !controls.canFormat()) return;
    const patch = buildPreviewFormatPatch(current.source, offset, text, selected.text, selected.selection, command, controls.math);
    if (patch && controls.apply({ ...patch, revealSource: command === 'format.link' }, current)) {
      controls.setDraft(false);
      controls.finishText(offset);
      if (command !== 'format.link') controls.focusBlock(offset);
    } else {
      controls.report(offset, '当前选区无法应用此格式，请在源码中继续。');
    }
  };
  return <><ReaderEditableBlock as={as} blockStart={offset} documentKey={controls.documentKey}
    enabled={active} initialCaret={active ? controls.activeText?.initialCaret : undefined}
    sourceText={text} id={props.id} className={props.className} tabIndex={0}
    onCommit={controls.commitText} onDraftChange={controls.setDraft} onActivityChange={controls.setActivity}
    onRestricted={controls.report} onFinish={() => controls.finishText(offset)}
    onCancel={() => controls.focusBlock(offset)}
    onStart={controls.ready || active ? () => controls.startText(offset) : undefined}
    onFormatKey={event => {
      const mac = /Macintosh|Mac OS X/u.test(navigator.userAgent);
      const shortcut = shortcutForKey(event, mac);
      if (!shortcut) return false;
      const command = PREVIEW_FORMAT_COMMANDS.find(id =>
        commandShortcut(EDITOR_COMMANDS[id], controls.shortcuts ?? {}, mac) === shortcut,
      );
      if (!command) return false;
      runFormat(command);
      return true;
    }}>
    {children}
  </ReaderEditableBlock>
    {active && toolbar && <SourceSelectionToolbar label="正文选区操作" position={toolbar} onCommand={id => {
      const command = PREVIEW_FORMAT_COMMANDS.find(value => value === id);
      if (command) runFormat(command);
    }} onMore={() => setShowMore(value => !value)} />}
    {active && toolbar && showMore && <div className="source-command-toolbar" role="toolbar" aria-label="更多正文格式"
      style={{ left: Math.min(toolbar.x, window.innerWidth - 175), top: toolbar.y + 26 }}
      onPointerDown={event => event.preventDefault()}>
      <button type="button" onClick={() => runFormat('format.strike')}>删除线</button>
      <button type="button" onClick={() => runFormat('format.inline-code')}>行内代码</button>
    </div>}
  </>;
}

function PreviewTask({ checked }: { readonly checked?: boolean }) {
  const controls = useContext(PreviewEditContext);
  const patch = useContext(TaskSpanContext);
  const editable = controls?.ready && patch;
  return <input type="checkbox" checked={Boolean(checked)} disabled={!editable}
    aria-label="任务完成状态" onChange={() => {
      if (editable) controls.apply(patch, { documentKey: controls.documentKey, revision: controls.revision });
    }} />;
}

function PreviewBlockActions({ span, label, inline = false, table }: {
  readonly span: PreviewSourceSpan;
  readonly label: string;
  readonly inline?: boolean;
  readonly table?: EditablePreviewTable;
}) {
  const controls = useContext(PreviewEditContext);
  if (!controls) return null;
  return <span className="preview-block-actions" data-inline={inline}>
    {table && <button type="button" disabled={!controls.ready} onClick={() => controls.openTable(table)}>编辑表格</button>}
    <button type="button" disabled={!controls.ready} onClick={() => controls.openSource(span)}>{label}</button>
  </span>;
}

function PreviewEquation({ children, equation }: {
  readonly children: ReactNode;
  readonly equation?: { span: PreviewSourceSpan; display: boolean };
}) {
  if (!equation) return children;
  const actions = <PreviewBlockActions span={equation.span} label="编辑公式源码" inline={!equation.display} />;
  return equation.display ? <>{children}{actions}</> : <span className="preview-inline-equation">{children}{actions}</span>;
}

function activePreviewSelection(offset: number | undefined) {
  const element = document.activeElement;
  const browserSelection = window.getSelection();
  if (!(element instanceof HTMLElement) || element.dataset.readerEditable !== 'true' ||
      element.dataset.sourceBlockStart !== String(offset) || browserSelection?.rangeCount !== 1) return null;
  const range = browserSelection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  const end = prefix.toString().length;
  const backward = browserSelection.anchorNode === range.endContainer && browserSelection.anchorOffset === range.endOffset;
  const selection: EditorSelection = { start, end, direction: range.collapsed ? 'none' : backward ? 'backward' : 'forward' };
  return { text: element.textContent ?? '', range, selection };
}

function exactPreviewText(node: Element | undefined, expected: string | undefined): string | undefined {
  if (expected === undefined || node?.children.some(child => child.type !== 'text')) return undefined;
  const rendered = node?.children.map(child => child.type === 'text' ? child.value : '').join('');
  return rendered === expected ? expected : undefined;
}

function previewDiagrams(tree: Root): ReadonlyMap<Element, string> {
  const diagrams = new Map<Element, string>();
  function visit(parent: Root | Element) {
    for (const child of parent.children) {
      if (diagrams.size >= MAX_MERMAID_DIAGRAMS) return;
      if (child.type !== 'element') continue;
      const source = mermaidSource(child);
      if (source) diagrams.set(child, source);
      else visit(child);
    }
  }
  visit(tree);
  return diagrams;
}

function PreviewImage({ reference, alt, title, resolveImage }: {
  readonly reference?: string;
  readonly alt?: string;
  readonly title?: string;
  readonly resolveImage?: ImageResolver;
}) {
  const [resolved, setResolved] = useState<{ reference: string; resolver: ImageResolver; url: string }>();
  useEffect(() => {
    if (!reference || !resolveImage || /^(?:[a-z][a-z0-9+.-]*:|\/\/|[\\/])/iu.test(reference)) return;
    let active = true;
    void resolveImage(reference).then(url => {
      if (active && url && /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon);base64,[\w+/]+={0,2}$/u.test(url)) {
        setResolved({ reference, resolver: resolveImage, url });
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [reference, resolveImage]);
  if (resolved && resolved.reference === reference && resolved.resolver === resolveImage) {
    return <img src={resolved.url} alt={alt ?? ''} title={title} loading="lazy" />;
  }
  return <span className="image-placeholder" role="img" aria-label={alt || '图片'}>{alt || '图片'}（未加载）</span>;
}

export function MarkdownPreview({ source, extensions, highlightCode = true, resolveImage, editing }: ReadingOptions & {
  readonly source: string;
  readonly resolveImage?: ImageResolver;
  readonly editing?: PreviewEditing;
}) {
  const [activeText, setActiveText] = useState<ActiveText | null>(null);
  const [activeTable, setActiveTable] = useState<{ table: EditablePreviewTable; version: PreviewVersion }>();
  const [feedback, setFeedback] = useState<{ reason: string; draft?: string }>();
  const authority = useRef(editing);
  authority.current = editing;
  const activity = useRef(new Set<PreviewActivity>());
  const activeSource = activeText?.source ?? source;
  const activeExtensions = activeText ? activeText.reading.extensions : extensions;
  const activeHighlight = activeText ? activeText.reading.highlightCode : highlightCode;
  const math = hasMathExtension({ extensions: activeExtensions });
  const projection = useMemo(() => buildPreviewProjection(activeSource, { extensions: activeExtensions, highlightCode: activeHighlight }),
    [activeSource, activeExtensions, activeHighlight]);
  const editable = Boolean(editing?.writable);
  const edits = useMemo(() => editable ? collectPreviewEdits(projection.snapshot) : undefined, [projection.snapshot, editable]);
  const markdownCode = useMemo(() => {
    const entries = new Map<number, { language?: string; value: string }>();
    function collect(node: import('mdast').Nodes) {
      if (node.type === 'code' && node.position?.start.offset !== undefined) {
        entries.set(node.position.start.offset, { language: node.lang ?? undefined, value: node.value });
      }
      if ('children' in node) node.children.forEach(collect);
    }
    collect(projection.snapshot.root);
    return entries;
  }, [projection.snapshot]);
  const frontmatter = projection.snapshot.root.children.find(node => node.type === 'yaml');
  const previewId = useId();
  const article = useRef<HTMLElement>(null);
  const restoreFocus = useRef<number | undefined>(undefined);
  const textPress = useRef<PreviewTextPress | null>(null);
  useLayoutEffect(() => {
    if (activeText || restoreFocus.current === undefined) return;
    const offset = restoreFocus.current;
    restoreFocus.current = undefined;
    article.current?.querySelector<HTMLElement>(`[data-source-block-start="${offset}"]`)?.focus({ preventScroll: true });
  });
  const diagrams = useMemo(() => hasMermaidExtension({ extensions: activeExtensions }) ? previewDiagrams(projection.renderTree) : undefined,
    [activeExtensions, projection]);
  const setActivity = useCallback((kind: PreviewActivity, active: boolean) => {
    if (activity.current.has(kind) === active) return;
    if (active) activity.current.add(kind);
    else activity.current.delete(kind);
    authority.current?.onActivityChange(kind, active);
  }, []);
  useEffect(() => () => {
    for (const kind of activity.current) setActivity(kind, false);
  }, [setActivity]);
  const setDraft = useCallback((dirty: boolean) => setActivity('draft', dirty), [setActivity]);
  const report = useCallback((_offset: number, reason: string, draft?: string) => {
    if (draft !== undefined) textPress.current = null;
    setFeedback({ reason, draft });
  }, []);
  const apply = (patch: PreviewPatch, version: PreviewVersion) => authority.current?.onEdit({
    ...patch, documentKey: version.documentKey, revision: version.revision,
  }) ?? false;
  const ready = Boolean(editing?.writable && editing.current && !activeText && !activeTable);
  const startText = (offset: number, initialCaret?: number) => {
    if (!editing || !ready) return;
    setFeedback(undefined);
    setActiveText({ offset, initialCaret, source, documentKey: editing.documentKey, revision: editing.revision,
      reading: { extensions, highlightCode } });
  };
  const startPressedText = () => {
    const press = textPress.current;
    if (!ready || !press?.released) return;
    textPress.current = null;
    if (press.documentKey === editing?.documentKey && press.source === source && edits?.text.get(press.offset) === press.text) {
      startText(press.offset, press.caret);
    }
  };
  useLayoutEffect(startPressedText);
  const controls: PreviewEditControls | null = editing?.writable ? {
    documentKey: editing.documentKey, revision: editing.revision, ready, activeText, math, shortcuts: editing.shortcuts,
    canFormat: () => !activity.current.has('composing') && !activity.current.has('committing'),
    focusBlock: offset => { restoreFocus.current = offset; },
    startText,
    finishText: offset => setActiveText(edit => edit?.offset === offset ? null : edit),
    commitText: async (offset, previous, next) => {
      if (activeText?.offset !== offset) return false;
      const patch = buildPreviewTextPatch(activeText.source, offset, previous, next, math);
      if (!patch || !apply(patch, activeText)) return false;
      const press = textPress.current;
      if (press?.documentKey === activeText.documentKey && press.source === activeText.source && press.activeOffset === offset) {
        // Blurring the old block refreshes the preview before the click may finish.
        // Carry the new block's caret to its corresponding position in the new source.
        if (press.offset + Number(press.source.startsWith('\uFEFF')) >= patch.to) {
          press.offset += patch.insert.length - (patch.to - patch.from);
        }
        press.source = press.source.slice(0, patch.from) + patch.insert + press.source.slice(patch.to);
      }
      return true;
    },
    setDraft, setActivity, report,
    apply,
    openSource: span => {
      if (!editing.onOpenSource({ ...span, documentKey: editing.documentKey, revision: editing.revision })) {
        setFeedback({ reason: '预览对应的源文档已变化，请等待刷新后重试。' });
      }
    },
    openTable: table => {
      setFeedback(undefined);
      setActiveTable({ table, version: editing });
    },
  } : null;

  const components = useMemo<Components>(() => {
    const fragmentId = (fragment: string) => `${previewId}-${fragment}`;
    const mappedId = (id?: string) => typeof id === 'string' && projection.fragments.has(id) ? fragmentId(id) : undefined;
    const renderHeading = (Tag: HeadingTag, { node, children, ...props }: HeadingProps) => {
      const offset = node?.position?.start.offset;
      const fragment = offset === undefined ? undefined : projection.headingIds.get(offset);
      const id = fragment ? fragmentId(fragment) : mappedId(props.id);
      return <PreviewText {...props} as={Tag} offset={offset}
        text={exactPreviewText(node, offset === undefined ? undefined : edits?.text.get(offset))}
        id={id} tabIndex={id ? -1 : undefined}>{children}</PreviewText>;
    };

    return {
      h1: props => renderHeading('h1', props),
      h2: props => renderHeading('h2', props),
      h3: props => renderHeading('h3', props),
      h4: props => renderHeading('h4', props),
      h5: props => renderHeading('h5', props),
      h6: props => renderHeading('h6', props),
      p: ({ node, children, ...props }) => {
        const offset = node?.position?.start.offset;
        return <PreviewText {...props} as="p" offset={offset}
          text={exactPreviewText(node, offset === undefined ? undefined : edits?.text.get(offset))}>{children}</PreviewText>;
      },
      a: ({ href, id, children, className, title, 'aria-label': label, 'aria-describedby': describedBy }) => {
        const fragment = resolvePreviewFragment(href, projection.fragments);
        if (!fragment) return <span className="preview-link-muted">{children}</span>;
        const anchor = fragmentId(fragment);
        const referenceId = mappedId(id);
        return <a href={`#${encodeURIComponent(anchor)}`} id={referenceId} className={className} title={title}
          aria-label={label} aria-describedby={mappedId(describedBy)} onClick={event => {
          event.preventDefault();
          const target = event.currentTarget.ownerDocument.getElementById(anchor);
          if (!target || !article.current?.contains(target)) return;
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'start' });
        }}>{children}</a>;
      },
      img: ({ src, alt, title }) => <PreviewImage reference={typeof src === 'string' ? src : undefined} alt={alt} title={title} resolveImage={resolveImage} />,
      li: ({ node, children, id, ...props }) => {
        const offset = node?.position?.start.offset;
        const task = offset === undefined ? undefined : edits?.tasks.get(offset);
        const fragment = mappedId(id);
        return <li {...props} id={fragment} tabIndex={fragment ? -1 : undefined}>
          <TaskSpanContext.Provider value={task}>{children}</TaskSpanContext.Provider>
        </li>;
      },
      input: ({ type, checked }) => type === 'checkbox' ? <PreviewTask checked={checked} /> : null,
      table: ({ node, children, ...props }) => {
        const offset = node?.position?.start.offset;
        const table = offset === undefined ? undefined : edits?.tables.get(offset);
        return <>
          <div className="table-scroll" role="region" aria-label="表格，可水平滚动" tabIndex={0}>
            <table {...props}>{children}</table>
          </div>
          {table && <PreviewBlockActions span={table.span} label="编辑表格源码" table={table.editable} />}
        </>;
      },
      pre: ({ node, children, ...props }) => {
        const diagram = node ? diagrams?.get(node) : undefined;
        const offset = node?.position?.start.offset;
        const code = offset === undefined ? undefined : edits?.code.get(offset);
        const block = offset === undefined ? undefined : markdownCode.get(offset);
        const equation = offset === undefined ? undefined : edits?.equations.get(offset);
        const codeProps = { ...props, tabIndex: 0, 'aria-label': '代码块，可水平滚动' };
        if (!block || equation) {
          return <PreviewEquation equation={equation}><pre {...codeProps}>{children}</pre></PreviewEquation>;
        }
        return <PreviewCodeBlock {...codeProps} language={block.language} code={block.value} diagram={diagram}
          diagramLimited={Boolean(!diagram && diagrams?.size === MAX_MERMAID_DIAGRAMS && node && mermaidSource(node))}
          actions={code && <PreviewBlockActions span={code.span} label={code.label} />}>
          {children}
        </PreviewCodeBlock>;
      },
      code: ({ node, children, ...props }) => {
        const offset = node?.position?.start.offset;
        const equation = offset === undefined ? undefined : edits?.equations.get(offset);
        return <PreviewEquation equation={equation?.display ? undefined : equation}><code {...props}>{children}</code></PreviewEquation>;
      },
      math: ({ node, children, ...props }: ExtraProps & { children?: ReactNode }) => {
        const offset = node?.position?.start.offset;
        const equation = offset === undefined ? undefined : edits?.equations.get(offset);
        return <PreviewEquation equation={equation}>{createElement('math', props, children)}</PreviewEquation>;
      },
    };
  }, [diagrams, edits, markdownCode, previewId, projection, resolveImage]);

  return <>
    <style>{READING_EXTENSION_CSS}</style>
    <article className="markdown-body" aria-label="Markdown 阅读预览" ref={article}
      onPointerDownCapture={event => {
        textPress.current = null;
        if (!event.isPrimary || event.button !== 0 || !activeText || !(event.target instanceof Element)) return;
        const block = event.target.closest<HTMLElement>('[data-source-block-start]:not([data-reader-editable])');
        if (!block || !event.currentTarget.contains(block)) return;
        const offset = Number(block.dataset.sourceBlockStart);
        const text = edits?.text.get(offset);
        const range = block.ownerDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
        if (text === undefined) return;
        const caret = range?.startContainer === block.firstChild ? range.startOffset
          : range?.startContainer === block && range.startOffset === 0 ? 0 : text.length;
        textPress.current = { documentKey: activeText.documentKey, source: activeText.source, activeOffset: activeText.offset,
          offset, text, caret, pointerId: event.pointerId, x: event.clientX, y: event.clientY, released: false };
      }}
      onPointerUpCapture={event => {
        const press = textPress.current;
        if (press?.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
          textPress.current = null;
          return;
        }
        press.released = true;
        startPressedText();
      }}
      onPointerCancel={event => {
        if (textPress.current?.pointerId === event.pointerId) textPress.current = null;
      }}>
      {feedback && <div className="preview-edit-feedback" role="status">
        <p>{feedback.reason}</p>
        {feedback.draft !== undefined && <textarea readOnly aria-label="未应用的正文" value={feedback.draft} />}
        <button type="button" onClick={() => setFeedback(undefined)}>关闭提示</button>
      </div>}
      {projection.unsupportedExtensions.length > 0 && <p className="preview-note" role="note">
        以下扩展以文本显示：{projection.unsupportedExtensions.map(extension => extensionLabels[extension]).join('、')}
      </p>}
      {frontmatter && <details className="preview-frontmatter">
        <summary>文档元数据（YAML）</summary>
        <pre tabIndex={0} aria-label="YAML 元数据"><code>{frontmatter.value}</code></pre>
      </details>}
      <PreviewEditContext.Provider value={controls}>
        {editable && projection.snapshot.body.length === 0 && <PreviewText as="p" offset={0} text="" className="reader-empty-block" />}
        <ReaderMarkdown tree={projection.renderTree} components={components} />
      </PreviewEditContext.Provider>
    </article>
    {activeTable && <PreviewTableEditor table={activeTable.table} onApply={patch => apply(patch, activeTable.version)}
      onClose={() => setActiveTable(undefined)} onDraftChange={setDraft}
      onCompositionChange={active => setActivity('composing', active)} />}
  </>;
}
