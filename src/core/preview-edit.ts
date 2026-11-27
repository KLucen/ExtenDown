import type { Heading, Nodes, Paragraph, PhrasingContent, Table } from 'mdast';
import { parseMarkdownSnapshot, type MarkdownSnapshot } from './markdown-snapshot.ts';
import { matchesPreviewInline, patchPreviewInline, type PreviewInlineText } from './preview-inline-text.ts';
import { applyReaderMappedTextEdit, applyReaderPlainTextEdit, escapeReaderPlainText } from './reader-edit.ts';
import { selectionMapFromSnapshot } from './selection-map.ts';
import { buildSourceCommandPatch, type EditorSelection } from './editor-commands.ts';

export interface PreviewSourceSpan {
  readonly from: number;
  readonly to: number;
  readonly expected: string;
}

export interface PreviewSourcePatch extends PreviewSourceSpan {
  readonly insert: string;
}

export const PREVIEW_FORMAT_COMMANDS = ['format.bold', 'format.italic', 'format.link', 'format.strike', 'format.inline-code'] as const;
export type PreviewFormatCommand = typeof PREVIEW_FORMAT_COMMANDS[number];

export type PreviewTableAlignment = 'left' | 'right' | 'center' | null;

export interface PreviewTableDraft {
  readonly rows: readonly (readonly string[])[];
  readonly alignments: readonly PreviewTableAlignment[];
}

export interface EditablePreviewTable extends PreviewSourceSpan {
  readonly draft: PreviewTableDraft;
  readonly indentation: string;
  readonly lineEnding: string;
}

export const MAX_TABLE_EDITOR_ROWS = 100;
export const MAX_TABLE_EDITOR_COLUMNS = 20;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function trimCell(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/gu, '');
}

function spanFromNode(snapshot: MarkdownSnapshot, node: Nodes): PreviewSourceSpan | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  return { from: start + snapshot.bomOffset, to: end + snapshot.bomOffset, expected: snapshot.body.slice(start, end) };
}

function editableInline(nodes: readonly PhrasingContent[]): boolean {
  return nodes.every(node => node.type === 'text' ||
    (node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete') && editableInline(node.children));
}

function editableTextNode(node: Nodes, blockStart: number): Heading | Paragraph | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || start > blockStart || end <= blockStart) return;
  if (start === blockStart && (node.type === 'heading' || node.type === 'paragraph')) {
    if (editableInline(node.children)) return node;
    return;
  }
  if ('children' in node) {
    for (const child of node.children) {
      const block = editableTextNode(child, blockStart);
      if (block) return block;
    }
  }
}

function visibleInlineText(nodes: readonly PhrasingContent[]): string {
  return nodes.map(node => node.type === 'text' ? node.value :
    node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete' ? visibleInlineText(node.children) : '').join('');
}

function escapePreviewText(text: string, math: boolean): string {
  const escaped = escapeReaderPlainText(text);
  return math ? escaped.replace(/\$/gu, '\\$') : escaped;
}

function tableDraft(snapshot: MarkdownSnapshot, table: Table): PreviewTableDraft | undefined {
  const alignments = table.align;
  if (!alignments?.length || alignments.length > MAX_TABLE_EDITOR_COLUMNS || table.children.length > MAX_TABLE_EDITOR_ROWS) return undefined;
  const rows: string[][] = [];
  for (const row of table.children) {
    if (row.children.length > alignments.length) return undefined;
    const values: string[] = [];
    for (const [index, cell] of row.children.entries()) {
      const span = spanFromNode(snapshot, cell);
      if (!span) return undefined;
      let value = span.expected.replace(/^\|/u, '');
      if (index === row.children.length - 1) value = value.replace(/(?<!\\)\|$/u, '');
      values.push(trimCell(value));
    }
    while (values.length < alignments.length) values.push('');
    rows.push(values);
  }
  return { rows, alignments };
}

export function collectPreviewEdits(source: string | MarkdownSnapshot, math = false) {
  const snapshot = typeof source === 'string' ? parseMarkdownSnapshot(source, { math }) : source;
  const map = selectionMapFromSnapshot(snapshot, snapshot.bomOffset ? 3 : 0);
  // Keep paragraphs containing Markdown soft line breaks editable. Their
  // changed ranges are still checked by the source mapper before commit.
  const mappedBlocks = new Map(map.blocks.filter(block => block.supported)
    .map(block => [block.blockStart, block]));
  const text = new Map<number, string>();
  const paragraphs = new Set<number>();
  const tasks = new Map<number, PreviewSourcePatch>();
  const tables = new Map<number, { span: PreviewSourceSpan; editable?: EditablePreviewTable }>();
  const code = new Map<number, { span: PreviewSourceSpan; label: string }>();
  const equations = new Map<number, { span: PreviewSourceSpan; display: boolean }>();

  const visit = (node: Nodes, topLevel: boolean): void => {
    const span = spanFromNode(snapshot, node);
    if (span) {
      const start = span.from - snapshot.bomOffset;
      if ((node.type === 'paragraph' || node.type === 'heading') && editableInline(node.children)) {
        const block = mappedBlocks.get(start);
        if (block || (node.type === 'heading' && node.children.length === 0)) {
          text.set(start, block?.visibleText ?? '');
          if (topLevel && node.type === 'paragraph') paragraphs.add(start);
        }
      }
      if (node.type === 'listItem' && typeof node.checked === 'boolean') {
        const marker = /^(?:[-+*]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t\r\n]|$)/u.exec(span.expected);
        if (marker && (marker[1] !== ' ') === node.checked) {
          const from = span.from + marker[0].length - 2;
          tasks.set(start, { from, to: from + 1, expected: marker[1], insert: node.checked ? ' ' : 'x' });
        }
      }
      if (node.type === 'table') {
        const draft = topLevel ? tableDraft(snapshot, node) : undefined;
        const lineStart = Math.max(snapshot.body.lastIndexOf('\n', start - 1), snapshot.body.lastIndexOf('\r', start - 1)) + 1;
        const indentation = snapshot.body.slice(lineStart, start);
        const lineEnding = /\r\n|\n|\r/u.exec(span.expected)?.[0] ?? '\n';
        tables.set(start, { span, editable: draft ? { ...span, draft, indentation, lineEnding } : undefined });
      }
      if (node.type === 'code') {
        code.set(start, { span, label: node.lang?.toLowerCase() === 'mermaid' ? '编辑 Mermaid 源码' : '编辑代码块源码' });
      }
      if (node.type === 'math' || node.type === 'inlineMath') {
        equations.set(start, { span, display: node.type === 'math' });
      }
    }
    if ('children' in node) node.children.forEach(child => visit(child, false));
  };
  snapshot.root.children.forEach(node => visit(node, true));
  return { text, paragraphs, tasks, tables, code, equations };
}

export function buildPreviewTextPatch(source: string, blockStart: number, previous: string, next: string, math: boolean,
  emptyParagraph = false, inline?: PreviewInlineText): PreviewSourcePatch | null {
  const snapshot = parseMarkdownSnapshot(source, { math });
  const { bomOffset } = snapshot;
  const bomBytes = bomOffset ? 3 : 0;
  const original = editableTextNode(snapshot.root, blockStart);
  const matchesVisibleText = (content: string) => {
    const block = editableTextNode(parseMarkdownSnapshot(content, { math }).root, blockStart);
    return block?.type === (original?.type ?? 'paragraph') && visibleInlineText(block.children) === next &&
      (!inline || matchesPreviewInline(block.children, inline));
  };
  if (previous === '' && (emptyParagraph || blockStart === 0 && source.length === bomOffset)) {
    if (/[\r\n\u0000\uD800-\uDFFF]/u.test(next)) return null;
    const from = blockStart + bomOffset;
    if (from < bomOffset || from > source.length) return null;
    const insert = escapePreviewText(next, math);
    const content = source.slice(0, from) + insert + source.slice(from);
    return !next || matchesVisibleText(content) ? { from, to: from, expected: '', insert } : null;
  }
  const span = original && spanFromNode(snapshot, original);
  if (!original || !span) return null;
  const visible = visibleInlineText(original.children);
  // Markdown trims a paragraph's trailing spaces, but the editing DOM can
  // keep them while the user types the next word.
  if (original.type === 'paragraph' && original.children.length === 1 && original.children[0].type === 'text' &&
      span.expected === previous && (previous !== visible || /[ \t]$/u.test(next)) &&
      !/[\r\n\u0000\uD800-\uDFFF]/u.test(next) && next.trimEnd()) {
    const block = editableTextNode(parseMarkdownSnapshot(source.slice(0, span.from) + next + source.slice(span.to), { math }).root, blockStart);
    if (block?.type === 'paragraph' && block.children.length === 1 &&
        block.children[0].type === 'text' && block.children[0].value === next.trimEnd()) {
      return { ...span, insert: next };
    }
  }
  if (visible !== previous) return null;
  if (!next) return { ...span, insert: original.type === 'heading' ? '#'.repeat(original.depth) : '' };
  if (!previous && original.type === 'heading' && !/[\r\n\u0000\uD800-\uDFFF]/u.test(next)) {
    const insert = '#'.repeat(original.depth) + ' ' + escapePreviewText(next, math);
    return matchesVisibleText(source.slice(0, span.from) + insert + source.slice(span.to)) ? { ...span, insert } : null;
  }
  const range = { blockStart, sourceText: previous, replacement: next };
  let edit = applyReaderMappedTextEdit(source, bomBytes, range, { allowEncoded: true, allowMultiline: true });
  if (edit.ok && !matchesVisibleText(edit.content)) {
    edit = applyReaderMappedTextEdit(source, bomBytes, range, {
      allowEncoded: true, allowMultiline: true, encode: value => escapePreviewText(value, math),
    });
  }
  if (!edit.ok || !matchesVisibleText(edit.content)) {
    const patch = inline && patchPreviewInline(snapshot, original.children, inline, math);
    return patch && matchesVisibleText(source.slice(0, patch.from) + patch.insert + source.slice(patch.to)) ? patch : null;
  }
  const from = edit.sourceStart + bomOffset;
  const to = edit.sourceEnd + bomOffset;
  return { from, to, expected: edit.sourceExact, insert: edit.content.slice(from, edit.content.length - source.length + to) };
}

interface PreviewParagraphSplit extends PreviewSourcePatch {
  readonly nextBlock: number;
  readonly empty: boolean;
}

/** Copy complete inline nodes and close/reopen emphasis at partial ranges. */
function paragraphSlice(children: readonly PhrasingContent[], source: string, from: number, to: number, math: boolean): string {
  let cursor = 0;
  function slice(node: PhrasingContent): string {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return '';
    const first = cursor;
    const raw = source.slice(start, end);
    if (node.type === 'text') {
      cursor += node.value.length;
      if (from <= first && cursor <= to) return raw;
      return escapePreviewText(node.value.slice(Math.max(from - first, 0), Math.max(to - first, 0)), math);
    }
    if (node.type !== 'emphasis' && node.type !== 'strong' && node.type !== 'delete') return '';
    const text = node.children.map(slice).join('');
    if (!text) return '';
    if (from <= first && cursor <= to) return raw;
    const childStart = node.children[0]?.position?.start.offset;
    const childEnd = node.children.at(-1)?.position?.end.offset;
    if (childStart === undefined || childEnd === undefined) return '';
    return source.slice(start, childStart) + text + source.slice(childEnd, end);
  }
  return children.map(slice).join('');
}

export function buildPreviewParagraphSplitPatch(source: string, blockStart: number, previous: string, text: string,
  selection: EditorSelection, math: boolean, emptyParagraph = false, inline?: PreviewInlineText): PreviewParagraphSplit | null {
  const { start, end } = selection;
  const boundary = (offset: number) => offset >= 0 && offset <= text.length &&
    (offset === text.length || graphemes.segment(text).containing(offset)?.index === offset);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || !boundary(start) || !boundary(end)) return null;
  const snapshot = parseMarkdownSnapshot(source, { math });
  const lineEnding = /\r\n|\n|\r/u.exec(snapshot.body)?.[0] ?? '\n';
  const gap = lineEnding.repeat(2);
  const node = snapshot.root.children.find(child => child.type === 'paragraph' && child.position?.start.offset === blockStart);
  const span = node && spanFromNode(snapshot, node);
  if ((!node || node.type !== 'paragraph' || !span) && !emptyParagraph) return null;
  const from = span?.from ?? blockStart + snapshot.bomOffset;
  const to = span?.to ?? from;
  if (from < snapshot.bomOffset || to > source.length) return null;
  const originalText = collectPreviewEdits(snapshot).text.get(blockStart);
  if ((emptyParagraph ? '' : originalText) !== previous &&
      (span?.expected !== previous || originalText !== previous.replace(/[ \t]+$/u, ''))) return null;

  const textPatch = previous !== text ? buildPreviewTextPatch(source, blockStart, previous, text, math, emptyParagraph, inline) : null;
  if (previous !== text && !textPatch) return null;
  const edited = textPatch
    ? parseMarkdownSnapshot(source.slice(0, textPatch.from) + textPatch.insert + source.slice(textPatch.to), { math })
    : snapshot;
  const paragraph = edited.root.children.find(child => child.type === 'paragraph' && child.position?.start.offset === blockStart);
  if (text && (!paragraph || paragraph.type !== 'paragraph' || !editableInline(paragraph.children))) return null;

  const left = text.slice(0, start).trimEnd();
  const right = text.slice(end).trimStart();
  const children = paragraph?.type === 'paragraph' ? paragraph.children : [];
  const leftSource = left ? paragraphSlice(children, edited.body, 0, left.length, math) : '';
  const rightSource = right ? paragraphSlice(children, edited.body, text.length - right.length, text.length, math) : '';
  const insert = leftSource + gap + rightSource;
  const nextBlock = blockStart + leftSource.length + gap.length;
  const next = collectPreviewEdits(source.slice(0, from) + insert + source.slice(to), math);
  if (left && (!next.paragraphs.has(blockStart) || next.text.get(blockStart) !== left)) return null;
  if (right && (!next.paragraphs.has(nextBlock) || next.text.get(nextBlock) !== right)) return null;
  return { from, to, expected: source.slice(from, to), insert, nextBlock, empty: !right };
}

export function buildPreviewFormatPatch(
  source: string,
  blockStart: number,
  previous: string,
  text: string,
  selection: EditorSelection,
  command: PreviewFormatCommand,
  math: boolean,
): (PreviewSourcePatch & { readonly selection?: EditorSelection }) | null {
  if (selection.start === selection.end) return null;
  const segments = graphemes.segment(text);
  if (segments.containing(selection.start)?.index !== selection.start ||
      (selection.end !== text.length && segments.containing(selection.end)?.index !== selection.end)) return null;
  const bomOffset = source.startsWith('\uFEFF') ? 1 : 0;
  const plain = applyReaderPlainTextEdit(source, bomOffset ? 3 : 0, { blockStart, sourceText: previous, replacement: text });
  if (!plain.ok) return null;
  if (previous !== text) {
    const textPatch = buildPreviewTextPatch(source, blockStart, previous, text, math);
    if (!textPatch || plain.content !== source.slice(0, textPatch.from) + textPatch.insert + source.slice(textPatch.to)) return null;
  }
  const format = buildSourceCommandPatch(command, text, selection);
  if (!format) return null;
  const from = plain.sourceStart + bomOffset;
  const newSelection = format.selection && {
    ...format.selection, start: from + format.selection.start, end: from + format.selection.end,
  };
  if (previous === text) {
    return { from: from + format.start, to: from + format.end, expected: format.expected, insert: format.insert, selection: newSelection };
  }
  return {
    from, to: plain.sourceEnd + bomOffset, expected: plain.sourceExact,
    insert: text.slice(0, format.start) + format.insert + text.slice(format.end), selection: newSelection,
  };
}

const alignmentMarkers = { left: ':---', right: '---:', center: ':---:' };

export function buildPreviewTablePatch(table: EditablePreviewTable, draft: PreviewTableDraft): PreviewSourcePatch | null {
  const { rows, alignments } = draft;
  if (rows.length < 1 || rows.length > MAX_TABLE_EDITOR_ROWS || alignments.length < 1 ||
      alignments.length > MAX_TABLE_EDITOR_COLUMNS || rows.some(row => row.length !== alignments.length)) return null;
  if (JSON.stringify(draft) === JSON.stringify(table.draft)) return { from: table.from, to: table.to, expected: table.expected, insert: table.expected };
  const rowSource = (cells: readonly string[]) => '| ' + cells.join(' | ') + ' |';
  const [header, ...body] = rows;
  const insert = [rowSource(header), rowSource(alignments.map(value => value ? alignmentMarkers[value] : '---')),
    ...body.map(rowSource)].join(table.lineEnding + table.indentation);

  // Verify that pasted Markdown did not add unintended columns or rows.
  const snapshot = parseMarkdownSnapshot(table.indentation + insert);
  const [parsed] = snapshot.root.children;
  if (snapshot.root.children.length !== 1 || parsed?.type !== 'table') return null;
  const verified = tableDraft(snapshot, parsed);
  if (JSON.stringify(verified?.alignments) !== JSON.stringify(alignments) ||
      JSON.stringify(verified?.rows) !== JSON.stringify(rows.map(row => row.map(trimCell)))) return null;
  return { from: table.from, to: table.to, expected: table.expected, insert };
}
