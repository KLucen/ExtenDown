import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreviewFormatPatch, buildPreviewTablePatch, buildPreviewTextPatch, collectPreviewEdits, type PreviewSourcePatch } from '../../src/core/preview-edit.ts';

const apply = (source: string, patch: PreviewSourcePatch) => {
  assert.equal(source.slice(patch.from, patch.to), patch.expected);
  return source.slice(0, patch.from) + patch.insert + source.slice(patch.to);
};

test('preview block edits use exact UTF-16 ranges with Unicode, BOM and CRLF', () => {
  const source = '\uFEFF# 标题 👩‍💻 ##\r\n\r\n组合 e\u0301 在这里\r\n\r\n~~~js\r\nx()\r\n~~~\r\n';
  const edits = collectPreviewEdits(source, false);
  const [heading, paragraph] = [...edits.text.keys()];
  const patch = buildPreviewTextPatch(source, heading, '标题 👩‍💻', '标题 👨‍💻', false);
  assert.ok(patch);
  assert.equal(patch.expected, '👩‍💻');
  assert.equal(apply(source, patch), source.replace('👩‍💻', '👨‍💻'));
  const combining = buildPreviewTextPatch(source, paragraph, '组合 e\u0301 在这里', '组合 e\u0300 在这里', false);
  assert.ok(combining);
  assert.equal(combining.expected, 'e\u0301');
  assert.equal(apply(source, combining), source.replace('e\u0301', 'e\u0300'));
  assert.equal(buildPreviewTextPatch(source, paragraph, '已经变化', '尝试覆盖', false), null);
});

test('preview text treats markup typed into a paragraph as plain text', () => {
  const source = '准备修改\r\n\r\n另一段\r\n';
  const patch = buildPreviewTextPatch(source, 0, '准备修改', '**新正文**', false);
  assert.ok(patch);
  assert.equal(apply(source, patch), '\\*\\*新正文\\*\\*\r\n\r\n另一段\r\n');
  const formula = buildPreviewTextPatch(source, 0, '准备修改', '原样显示 $x$', true);
  assert.ok(formula);
  assert.equal(apply(source, formula), '原样显示 \\$x\\$\r\n\r\n另一段\r\n');
});

test('preview formatting joins native text and the shared formatting command in one patch', () => {
  const source = '\uFEFF# 章节\r\n\r\n旧文本\r\n';
  const paragraph = [...collectPreviewEdits(source, false).text.keys()][1];
  const text = '新增 e\u0301 👨‍💻';
  const patch = buildPreviewFormatPatch(source, paragraph, '旧文本', text, {
    start: 3, end: 5, direction: 'backward',
  }, 'format.bold', false);
  assert.ok(patch);
  const next = apply(source, patch);
  assert.equal(next, '\uFEFF# 章节\r\n\r\n新增 **e\u0301** 👨‍💻\r\n');
  assert.equal(next.slice(patch.selection?.start, patch.selection?.end), 'e\u0301');
  assert.equal(patch.selection?.direction, 'backward');
  assert.equal(buildPreviewFormatPatch(source, paragraph, '旧文本', text, {
    start: 3, end: 4, direction: 'forward',
  }, 'format.bold', false), null);
});

test('task and source actions refer to parsed markers with exact preview offsets', () => {
  const source = '\uFEFF> 1. [X] 父任务\r\n>    - [ ] 子任务\r\n\r\n普通 $x$ 内容。\r\n\r\n~~~mermaid\r\nflowchart TD\r\n~~~\r\n';
  const edits = collectPreviewEdits(source, true);
  const [first, nested] = edits.tasks.values();
  assert.equal(apply(source, first), source.replace('[X]', '[ ]'));
  assert.equal(apply(source, nested), source.replace('[ ]', '[x]'));
  const [mermaid] = edits.code.values();
  assert.equal(mermaid.label, '编辑 Mermaid 源码');
  assert.equal(source.slice(mermaid.span.from, mermaid.span.to), '~~~mermaid\r\nflowchart TD\r\n~~~');
  const [equation] = edits.equations.values();
  assert.equal(source.slice(equation.span.from, equation.span.to), '$x$');
});

test('table editing keeps adjacent source and existing cell Markdown', () => {
  const source = '\uFEFF标题\r\n\r\n  | a | b |\r\n  | :-- | --: |\r\n  | **x** | \\\\ | y\\|z |\r\n\r\n~~~js\r\nx()\r\n~~~\r\n';
  // A row with an extra column remains available through its source entry.
  assert.equal([...collectPreviewEdits(source, false).tables.values()][0].editable, undefined);
  const exact = source.replace('\\\\ | ', '');
  const [table] = [...collectPreviewEdits(exact, false).tables.values()];
  assert.ok(table.editable);
  assert.deepEqual(table.editable.draft.rows, [['a', 'b'], ['**x**', 'y\\|z']]);
  assert.deepEqual(table.editable.draft.alignments, ['left', 'right']);
  const unchanged = buildPreviewTablePatch(table.editable, table.editable.draft);
  assert.ok(unchanged);
  assert.equal(apply(exact, unchanged), exact);
  const patch = buildPreviewTablePatch(table.editable, {
    rows: [['a', 'b', 'c'], ['**x**', 'y\\|z', '✅'], ['', '', '']],
    alignments: ['left', 'center', null],
  });
  assert.ok(patch);
  assert.equal(apply(exact, patch), '\uFEFF标题\r\n\r\n  | a | b | c |\r\n  | :--- | :---: | --- |\r\n  | **x** | y\\|z | ✅ |\r\n  |  |  |  |\r\n\r\n~~~js\r\nx()\r\n~~~\r\n');
  assert.equal(buildPreviewTablePatch(table.editable, { rows: [['a | b', 'c']], alignments: [null, null] }), null);
});
