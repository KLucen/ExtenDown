import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreviewFormatPatch, buildPreviewParagraphSplitPatch, buildPreviewTablePatch, buildPreviewTextPatch, collectPreviewEdits, type PreviewSourcePatch } from '../../src/core/preview-edit.ts';

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

test('live preview can publish a trailing space and then continue the next word', () => {
  const initial = 'First\n\nSecond';
  const space = buildPreviewTextPatch(initial, 0, 'First', 'First ', false);
  assert.ok(space);
  const spaced = apply(initial, space);
  assert.equal(spaced, 'First \n\nSecond');
  const word = buildPreviewTextPatch(spaced, 0, 'First ', 'First word', false);
  assert.ok(word);
  assert.equal(apply(spaced, word), 'First word\n\nSecond');
  assert.ok(buildPreviewParagraphSplitPatch(spaced, 0, 'First ', 'First ',
    { start: 6, end: 6, direction: 'none' }, false));
});

test('a heading cleared in live preview can be typed again', () => {
  const source = '## title\n\nOther text';
  const clear = buildPreviewTextPatch(source, 0, 'title', '', false);
  assert.ok(clear);
  const blank = apply(source, clear);
  assert.equal(collectPreviewEdits(blank).text.get(0), '');
  const rewrite = buildPreviewTextPatch(blank, 0, '', 'new title', false);
  assert.ok(rewrite);
  assert.equal(apply(blank, rewrite), '## new title\n\nOther text');
});

test('preview keeps soft line breaks visible and maps edits inside later lines', () => {
  const source = ['123123', '', '33', '44', '22', '445'].join('\n');
  const edits = collectPreviewEdits(source, false);
  const offset = source.indexOf('33');
  assert.equal(edits.text.get(offset), '33\n44\n22\n445');
  assert.ok(edits.paragraphs.has(offset));
  const patch = buildPreviewTextPatch(source, offset, '33\n44\n22\n445', '33\n44\n22\n4456', false);
  assert.ok(patch);
  assert.equal(apply(source, patch), source + '6');
});

test('Enter splits an existing soft-break paragraph and keeps both preview blocks editable', () => {
  const source = ['33', '44', '22', '445'].join('\n');
  const previous = '33\n44\n22\n445';
  const split = buildPreviewParagraphSplitPatch(source, 0, previous, previous,
    { start: 6, end: 6, direction: 'none' }, false);
  assert.ok(split);
  const next = apply(source, split);
  assert.equal(next, '33\n44\n\n22\n445');
  const edits = collectPreviewEdits(next, false);
  assert.equal(edits.text.get(0), '33\n44');
  assert.equal(edits.text.get(split.nextBlock), '22\n445');
});

test('preview starts the first paragraph in empty documents, preserving a BOM', () => {
  for (const source of ['', '\uFEFF']) {
    const patch = buildPreviewTextPatch(source, 0, '', '新的 **段落**', false);
    assert.ok(patch);
    assert.equal(apply(source, patch), source + '新的 \\*\\*段落\\*\\*');
    assert.equal(buildPreviewTextPatch(source, 0, '', '多行\n正文', false), null);
  }
  assert.equal(buildPreviewTextPatch('已有段落', 0, '', '覆盖', false), null);
});

test('preview edits multiple styled leaves in one commit and preserves their Markdown delimiters', () => {
  const source = '\uFEFF**原文** and _italic_ &amp; end\r\n';
  const previous = '原文 and italic & end';
  const patch = buildPreviewTextPatch(source, 0, previous, '新文 and *原样* & end', false, false, [
    { type: 'strong', children: ['新文'] }, ' and ', { type: 'emphasis', children: ['*原样*'] }, ' & end',
  ]);
  assert.ok(patch);
  assert.equal(apply(source, patch), '\uFEFF**新文** and _\\*原样\\*_ &amp; end\r\n');
  assert.equal(buildPreviewTextPatch(source, 0, previous, 'changes and italic & end', false, false, [
    'changes and ', { type: 'emphasis', children: ['italic'] }, ' & end',
  ]), null);
  const deletion = buildPreviewTextPatch('**文字**\n\n后续', 0, '文字', '', false);
  assert.ok(deletion);
  assert.equal(apply('**文字**\n\n后续', deletion), '\n\n后续');
});

test('Enter splits a styled paragraph with pending edits, restores delimiters and preserves the file line ending', () => {
  const source = '\uFEFF一段 **原文** _文字_\r\n\r\n另一段\r\n';
  const previous = '一段 原文 文字';
  const text = '一段 新文 后半';
  const patch = buildPreviewParagraphSplitPatch(source, 0, previous, text, { start: 4, end: 4 }, false, false, [
    '一段 ', { type: 'strong', children: ['新文'] }, ' ', { type: 'emphasis', children: ['后半'] },
  ]);
  assert.ok(patch);
  const next = apply(source, patch);
  assert.equal(next, '\uFEFF一段 **新**\r\n\r\n**文** _后半_\r\n\r\n另一段\r\n');
  assert.equal(next.slice(patch.nextBlock + 1).split('\r\n')[0], '**文** _后半_');
  assert.equal(patch.empty, false);
});

test('Enter makes a new empty paragraph at the current boundary and rejects splitting a grapheme', () => {
  const source = 'First 👩‍💻\n\nNext';
  const previous = 'First 👩‍💻';
  assert.equal(buildPreviewParagraphSplitPatch(source, 0, previous, previous, { start: 7, end: 7 }, false), null);
  const split = buildPreviewParagraphSplitPatch(source, 0, previous, previous,
    { start: previous.length, end: previous.length }, false);
  assert.ok(split);
  assert.equal(split.empty, true);
  const next = apply(source, split);
  const insert = buildPreviewTextPatch(next, split.nextBlock, '', 'Middle', false, true);
  assert.ok(insert);
  assert.equal(apply(next, insert), 'First 👩‍💻\n\nMiddle\n\nNext');
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
