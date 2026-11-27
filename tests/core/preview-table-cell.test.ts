import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdownSnapshot } from '../../src/core/markdown-snapshot.ts';
import type { PreviewSourcePatch } from '../../src/core/preview-edit.ts';
import { buildPreviewCellPatch, collectPreviewTableCells } from '../../src/core/preview-table-cell.ts';

function cellAt(source: string, row: number, column: number) {
  return [...collectPreviewTableCells(parseMarkdownSnapshot(source)).values()][row]?.[column];
}

function apply(source: string, patch: PreviewSourcePatch | null): string {
  assert.ok(patch);
  assert.equal(source.slice(patch.from, patch.to), patch.expected);
  return source.slice(0, patch.from) + patch.insert + source.slice(patch.to);
}

test('applying a table cell edit escapes Markdown and preserves BOM, alignment and literal row spacing', () => {
  const source = '\uFEFF| Zone  | State|\r\n|:--- | ---:|\r\n| west |ok |\r\n\r\nAfter\r\n';
  const cell = cellAt(source, 1, 1);
  assert.ok(cell);
  assert.equal(cell.text, 'ok');
  const edited = apply(source, buildPreviewCellPatch(source, cell, 'Good | *new* $x$ 👩🏽‍💻', true));
  assert.equal(edited, source.replace('ok', 'Good \\| \\*new\\* \\$x\\$ 👩🏽‍💻'));
  assert.equal(buildPreviewCellPatch(source.replace('ok', 'stale'), cell, 'replacement', false), null);
  assert.equal(buildPreviewCellPatch(source, cell, 'multiple\nlines', false), null);
});

test('editable cells preserve bold and italic markers through multiple edits', () => {
  const source = '| Key | Value |\n| --- | --- |\n| **Item** and *color* | a\\|b |\n';
  const cell = cellAt(source, 1, 0);
  assert.ok(cell);
  assert.equal(cell.text, 'Item and color');
  const boldText = apply(source, buildPreviewCellPatch(source, cell, '商品 | good and color', false));
  assert.equal(boldText, source.replace('**Item**', '**商品 \\| good**'));
  const next = cellAt(boldText, 1, 0);
  assert.ok(next);
  const italicText = apply(boldText, buildPreviewCellPatch(boldText, next, '商品 | good and colour', false));
  assert.equal(italicText, boldText.replace('*color*', '*colour*'));
  assert.equal(buildPreviewCellPatch(source, cell, 'replaced everything', false), null);
});

test('explicit and padded empty cells can be edited inside a quoted table', () => {
  const source = '> | A |  | C |\n> | --- | --- | --- |\n> | x |\n';
  const header = cellAt(source, 0, 1);
  assert.ok(header);
  assert.equal(header.text, '');
  const withHeader = apply(source, buildPreviewCellPatch(source, header, 'B', false));
  assert.equal(cellAt(withHeader, 0, 1)?.text, 'B');
  const padded = cellAt(withHeader, 1, 2);
  assert.ok(padded);
  const edited = apply(withHeader, buildPreviewCellPatch(withHeader, padded, 'z', false));
  assert.equal(edited, withHeader.replace('> | x |', '> | x |  | z |'));
  assert.equal(cellAt(edited, 1, 1)?.text, '');
  assert.equal(cellAt(edited, 1, 2)?.text, 'z');
});

test('one edit session preserves independent formatting spans within the same cell', () => {
  const source = '| Key |\n| --- |\n| **first** &amp; _second_ |\n';
  const cell = cellAt(source, 1, 0);
  assert.ok(cell);
  const patch = buildPreviewCellPatch(source, cell, 'new | first & changed', false, [
    { type: 'strong', children: ['new | first'] }, ' & ', { type: 'emphasis', children: ['changed'] },
  ]);
  assert.equal(apply(source, patch), '| Key |\n| --- |\n| **new \\| first** &amp; _changed_ |\n');
});

test('clearing a first or last cell preserves rows without optional outer pipes', () => {
  const source = 'A | B\n--- | ---\nx | y\nx | z\n';
  const first = cellAt(source, 0, 0);
  assert.ok(first);
  const withEmptyHeader = apply(source, buildPreviewCellPatch(source, first, '', false));
  assert.equal(cellAt(withEmptyHeader, 0, 0)?.text, '');
  const last = cellAt(withEmptyHeader, 1, 1);
  assert.ok(last);
  const edited = apply(withEmptyHeader, buildPreviewCellPatch(withEmptyHeader, last, '', false));
  assert.equal(cellAt(edited, 1, 1)?.text, '');
  assert.equal(cellAt(edited, 2, 1)?.text, 'z');
});

test('links, formulas and code spans retain the normal preview and source editing actions', () => {
  const source = '| A | B | C |\n| -- | -- | -- |\n| [label](ref.md) | $x$ | `code` |\n';
  const snapshot = parseMarkdownSnapshot(source, { math: true });
  const [, row] = [...collectPreviewTableCells(snapshot).values()];
  assert.deepEqual(row, [undefined, undefined, undefined]);
});
