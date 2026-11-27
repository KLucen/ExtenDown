import type { Nodes, Table, TableCell } from 'mdast';
import { parseMarkdownSnapshot, type MarkdownSnapshot } from './markdown-snapshot.ts';
import type { PreviewSourcePatch } from './preview-edit.ts';
import { matchesPreviewInline, patchPreviewInline, type PreviewInlineText } from './preview-inline-text.ts';
import { applyReaderMappedTextEdit, escapeReaderPlainText } from './reader-edit.ts';

export interface EditablePreviewCell {
  readonly id: string;
  readonly rowStart: number;
  readonly tableStart: number;
  readonly row: number;
  readonly column: number;
  readonly offset?: number;
  readonly text: string;
}

type CellRows = ReadonlyMap<number, readonly (EditablePreviewCell | undefined)[]>;

function walkTables(node: Nodes, visit: (table: Table) => void): void {
  if (node.type === 'table') visit(node);
  else if ('children' in node) node.children.forEach(child => walkTables(child, visit));
}

function inspectCell(cell?: TableCell): { text: string; format: string } | undefined {
  let text = '';
  function format(node: Nodes): string {
    if (node.type === 'text') {
      text += node.value;
      return '';
    }
    if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
      return '[' + node.type + node.children.map(format).join('') + ']';
    }
    return '!';
  }
  const structure = cell?.children.map(format).join('') ?? '';
  return structure.includes('!') ? undefined : { text, format: structure };
}

export function collectPreviewTableCells(snapshot: MarkdownSnapshot): CellRows {
  const result = new Map<number, (EditablePreviewCell | undefined)[]>();
  walkTables(snapshot.root, table => {
    const tableStart = table.position?.start.offset;
    const columns = table.align?.length;
    if (tableStart === undefined || !columns) return;
    for (const [index, row] of table.children.entries()) {
      const start = row.position?.start.offset;
      if (start === undefined) continue;
      result.set(start, Array.from({ length: columns }, (_, column) => {
        const cell = row.children[column];
        const offset = cell?.position?.start.offset;
        if (cell && offset === undefined) return undefined;
        const content = inspectCell(cell);
        if (!content) return undefined;
        return { id: start + ':' + column, rowStart: start, tableStart, row: index, column, offset, text: content.text };
      }));
    }
  });
  return result;
}

function tableAt(snapshot: MarkdownSnapshot, start: number): Table | undefined {
  let matching: Table | undefined;
  walkTables(snapshot.root, table => {
    if (table.position?.start.offset === start) matching = table;
  });
  return matching;
}

export function buildPreviewCellPatch(
  source: string, target: EditablePreviewCell, value: string, math: boolean, inline?: PreviewInlineText,
): PreviewSourcePatch | null {
  if (/[\r\n\u0000\uD800-\uDFFF]/u.test(value)) return null;
  const snapshot = parseMarkdownSnapshot(source, { math });
  const table = tableAt(snapshot, target.tableStart);
  const row = table?.children[target.row];
  const cell = row?.children[target.column];
  const content = inspectCell(cell);
  if (!table?.align || !row || target.column >= table.align.length || !content ||
      content.text !== target.text || cell?.position?.start.offset !== target.offset) return null;

  const { bomOffset } = snapshot;
  const text = value.replace(/^[ \t]+|[ \t]+$/gu, '');
  const escape = (input: string) => {
    const escaped = escapeReaderPlainText(input);
    return math ? escaped.replace(/\$/gu, '\\$') : escaped;
  };
  const patch = (start: number, end: number, insert: string) => ({
    from: start + bomOffset, to: end + bomOffset, expected: snapshot.body.slice(start, end), insert,
  });
  const validate = (candidate: PreviewSourcePatch, expectedInline?: PreviewInlineText): boolean => {
    const nextSource = source.slice(0, candidate.from) + candidate.insert + source.slice(candidate.to);
    const nextTable = tableAt(parseMarkdownSnapshot(nextSource, { math }), target.tableStart);
    const nextRow = nextTable?.children[target.row];
    const nextCell = nextRow?.children[target.column];
    const nextContent = inspectCell(nextCell);
    return Boolean(nextRow && nextContent?.text === text && nextContent.format === content.format &&
      nextTable?.children.length === table.children.length &&
      nextRow.children.length === Math.max(row.children.length, target.column + 1) &&
      nextTable.align?.length === table.align?.length &&
      table.align?.every((alignment, index) => alignment === nextTable.align?.[index]) &&
      (!expectedInline || nextCell && matchesPreviewInline(nextCell.children, expectedInline)));
  };

  let candidate: PreviewSourcePatch;
  if (!cell) {
    const start = row.position?.start.offset;
    const end = row.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    const raw = snapshot.body.slice(start, end);
    const trailingPipe = /\\*\|$/u.exec(raw)?.[0];
    let separator = trailingPipe && trailingPipe.length % 2 === 1 ? ' ' : ' | ';
    separator += ' | '.repeat(target.column - row.children.length);
    candidate = patch(end, end, separator + escape(text) + ' |');
  } else if (content.format) {
    if (target.offset === undefined) return null;
    if (text === target.text) return patch(target.offset, target.offset, '');
    const formatted = inline && patchPreviewInline(snapshot, cell.children, inline, math);
    if (formatted && validate(formatted, inline)) return formatted;
    const edit = applyReaderMappedTextEdit(source, bomOffset ? 3 : 0, {
      blockStart: target.offset, sourceText: target.text, replacement: text,
    }, { allowEncoded: true, encode: escape });
    if (!edit.ok) return null;
    const replacement = edit.content.slice(edit.sourceStart + bomOffset, edit.content.length - source.length + edit.sourceEnd + bomOffset);
    candidate = patch(edit.sourceStart, edit.sourceEnd, replacement);
  } else {
    const start = cell.position?.start.offset;
    const end = cell.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    if (text === target.text) return patch(start, start, '');
    const first = cell.children[0]?.position?.start.offset;
    const last = cell.children.at(-1)?.position?.end.offset;
    // For an explicitly empty cell, insert just inside its leading delimiter.
    const interior = start + Number(snapshot.body[start] === '|');
    const startsWithDelimiter = snapshot.body[start] === '|';
    const escaped = escape(text);
    const prefix = !text && !startsWithDelimiter ? '| ' : '';
    const suffix = !text && target.column + 1 === row.children.length && !snapshot.body.slice(start, end).trimEnd().endsWith('|')
      ? ' |' : '';
    candidate = first !== undefined && last !== undefined
      ? patch(first, last, prefix + escaped + suffix) : patch(interior, interior, ' ' + escaped + ' ');
  }

  return validate(candidate) ? candidate : null;
}
