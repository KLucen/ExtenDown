import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreviewProjection } from '../../src/core/preview-projection.ts';
import { buildPreviewLayout } from '../../src/renderer/preview-layout.ts';

function previewLayout(source, blankOffset) {
  const { renderTree, snapshot } = buildPreviewProjection(source);
  return buildPreviewLayout(renderTree, snapshot.body, blankOffset);
}

function blocks(tree) {
  return tree.children.filter(node => node.type === 'element');
}

test('normal paragraph separation uses the Markdown block margins', () => {
  const { renderTree, snapshot } = buildPreviewProjection('正文\n\n33\n44\n22\n4');
  assert.equal(buildPreviewLayout(renderTree, snapshot.body), renderTree);
});

test('extra blank source lines render between top-level blocks including in CRLF files', () => {
  const [first, spacing, second] = blocks(previewLayout('\uFEFF正文\r\n\t\r\n\r\n\r\n33\r\n44\r\n22\r\n4'));
  assert.equal(first.tagName, 'p');
  assert.equal(spacing.properties.style, '--preview-blank-lines: 2');
  assert.equal(second.position.start.line, 5);
});

test('the Enter target keeps its position between paragraphs after further blank lines', () => {
  const source = '正文\n\n\n\n\n\n33\n44\n22\n4';
  const [first, spacing, draft, second] = blocks(previewLayout(source, 6));
  assert.equal(first.tagName, 'p');
  assert.equal(spacing.properties.style, '--preview-blank-lines: 2');
  assert.equal(draft.properties.dataEmptyDraft, 6);
  assert.equal(second.position.start.line, 7);
});

test('Enter at the start of the first paragraph leaves visible leading blank lines', () => {
  const [spacing, text] = blocks(previewLayout('\n\n正文'));
  assert.equal(spacing.properties.style, '--preview-blank-lines: 2');
  assert.equal(text.position.start.line, 3);
});

test('a reference definition does not add blank spacing to the preview', () => {
  assert.equal(blocks(previewLayout('正文\n\n[ref]: ./other.md\n\n\n结尾')).length, 2);
});
