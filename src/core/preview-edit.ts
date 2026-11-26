import type { Nodes, Table } from 'mdast';
import { parseMarkdownSnapshot, type MarkdownSnapshot } from './markdown-snapshot.ts';
import { applyReaderMappedTextEdit, applyReaderPlainTextEdit, escapeReaderPlainText, isReaderPlainTextBlock } from './reader-edit.ts';
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
  const text = new Map(map.blocks.filter(block => isReaderPlainTextBlock(map, block))
    .map(block => [block.blockStart, block.visibleText]));
  const tasks = new Map<number, PreviewSourcePatch>();
  const tables = new Map<number, { span: PreviewSourceSpan; editable?: EditablePreviewTable }>();
  const code = new Map<number, { span: PreviewSourceSpan; label: string }>();
  const equations = new Map<number, { span: PreviewSourceSpan; display: boolean }>();

  const visit = (node: Nodes, topLevel: boolean): void => {
    const span = spanFromNode(snapshot, node);
    if (span) {
      const start = span.from - snapshot.bomOffset;
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
  return { text, tasks, tables, code, equations };
}

export function buildPreviewTextPatch(source: string, blockStart: number, previous: string, next: string, math: boolean): PreviewSourcePatch | null {
  const bomOffset = source.startsWith('\uFEFF') ? 1 : 0;
  const bomBytes = bomOffset ? 3 : 0;
  const range = { blockStart, sourceText: previous, replacement: next };
  const direct = applyReaderMappedTextEdit(source, bomBytes, range);
  if (!direct.ok) return null;
  const matchesVisibleText = (content: string) => {
    if (next === '') return true;
    const snapshot = parseMarkdownSnapshot(content, { math });
    const block = selectionMapFromSnapshot(snapshot, bomBytes).blocks.find(candidate => candidate.blockStart === blockStart);
    return block?.supported && block.visibleText === next;
  };
  const edit = matchesVisibleText(direct.content) ? direct : applyReaderPlainTextEdit(source, bomBytes, {
    ...range, replacement: math ? escapeReaderPlainText(next).replace(/\$/gu, '\\$') : escapeReaderPlainText(next),
  });
  if (!edit.ok || !matchesVisibleText(edit.content)) return null;
  const from = edit.sourceStart + bomOffset;
  const to = edit.sourceEnd + bomOffset;
  return { from, to, expected: edit.sourceExact, insert: edit.content.slice(from, edit.content.length - source.length + to) };
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
