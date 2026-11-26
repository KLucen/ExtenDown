import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreviewProjection, resolvePreviewFragment } from '../src/core/preview-projection.ts';
import { extraLanguagesExtension, mathMarkdownExtension } from '../src/core/plugins/builtin.ts';
import { loadAdditionalLanguages, loadMathRenderer } from '../src/core/plugins/reading-extensions.ts';

function elements(root) {
  const found = [];
  for (const child of root.children ?? []) {
    if (child.type === 'element') found.push(child);
    found.push(...elements(child));
  }
  return found;
}

test('preview projects CommonMark/GFM without showing its frontmatter', () => {
  const source = '\uFEFF---\r\nprivate: HIDDEN_FRONTMATTER\r\n---\r\n# 中文\r\n\r\n**重点** 和 ~~删除~~\r\n\r\n- [x] 完成\r\n\r\n| A | B |\r\n|---|---|\r\n| 中文 | 😀 |\r\n';
  const preview = buildPreviewProjection(source);
  const tags = elements(preview.renderTree);
  for (const name of ['h1', 'strong', 'del', 'table', 'input']) {
    assert.ok(tags.some(element => element.tagName === name), name);
  }
  const checkbox = tags.find(element => element.tagName === 'input');
  assert.equal(checkbox.properties.checked, true);
  assert.equal(checkbox.properties.disabled, true);
  assert.doesNotMatch(JSON.stringify(preview.renderTree), /HIDDEN_FRONTMATTER/);
  assert.equal(preview.headingIds.get(source.indexOf('# 中文') - 1), '中文', 'HAST offsets exclude the UTF-8 BOM character');
});

test('the original HTML cleaning rejects whole dangerous containers and unsafe attributes', () => {
  const source = [
    '<script>SCRIPT_PAYLOAD</script>',
    '<iframe src="https://example.invalid/iframe">FRAME_PAYLOAD</iframe>',
    '<video><table>FOSTER_PAYLOAD<img src="foster.png"></table></video>',
    '<a href="javascript:alert(1)" onclick="alert(1)">可见链接文字</a>',
    '<img src="https://example.invalid/image.png" onerror="alert(1)" alt="外部图片">',
  ].join('\n\n');
  const preview = buildPreviewProjection(source);
  const serialized = JSON.stringify(preview.renderTree);
  assert.doesNotMatch(serialized, /SCRIPT_PAYLOAD|FRAME_PAYLOAD|FOSTER_PAYLOAD|foster\.png|javascript:|onclick|onerror/i);
  assert.match(serialized, /可见链接文字/);
  assert.ok(elements(preview.renderTree).every(element => !['script', 'iframe', 'video'].includes(element.tagName)));
});

test('fragment lookup accepts only titles in the current source, including duplicates and Unicode', () => {
  const { fragments } = buildPreviewProjection('# 中文\n\n## 中文\n\n> # 引文标题\n');
  assert.equal(resolvePreviewFragment('#' + encodeURIComponent('中文'), fragments), '中文');
  assert.equal(resolvePreviewFragment('#中文-1', fragments), '中文-1');
  for (const value of ['#引文标题', '#%E0%A4', '#', 'paper.md#中文', 'file:///paper.md#中文', 'https://example.invalid/#中文', undefined]) {
    assert.equal(resolvePreviewFragment(value, fragments), null);
  }
});

test('the optional math module adds MathML only for parsed Markdown formulas', async () => {
  await loadMathRenderer();
  const source = [
    'Inline $x^2$',
    ['$$', '\\frac{1}{x}', '$$'].join('\n'),
    '<math><mi>RAW_MARKUP</mi></math>',
    ['~~~text', '$x^2$', '~~~'].join('\n'),
    String.raw`$\href{javascript:alert(1)}{y}$`,
  ].join('\n\n');
  const core = buildPreviewProjection(source);
  assert.ok(core.unsupportedExtensions.includes('display-math'));
  assert.ok(!elements(core.renderTree).some(node => node.tagName === 'math'));
  const active = buildPreviewProjection(source, { extensions: [mathMarkdownExtension] });
  const tags = elements(active.renderTree);
  const equations = tags.filter(node => node.tagName === 'math');
  assert.equal(equations.length, 3);
  assert.equal(equations.filter(node => node.properties.display === 'block').length, 1);
  assert.ok(tags.some(node => node.tagName === 'mfrac'));
  assert.ok(tags.some(node => node.tagName === 'msup'));
  assert.ok(!tags.some(node => 'href' in node.properties));
  assert.doesNotMatch(JSON.stringify(active.renderTree), /RAW_MARKUP/);
});

test('code fences highlight selected languages and keep unsupported code literal', () => {
  const source = ['~~~js', 'const tag = "<script>";', '~~~', '', '~~~unknown', 'const x = 1', '~~~'].join('\n');
  const highlighted = buildPreviewProjection(source, { highlightCode: true });
  const spans = elements(highlighted.renderTree).filter(node => node.tagName === 'span');
  assert.ok(spans.some(span => span.properties.className?.includes('hljs-keyword')));
  assert.ok(spans.some(span => span.properties.className?.includes('hljs-string')));
  assert.ok(!elements(highlighted.renderTree).some(node => node.tagName === 'script'));
  const codes = elements(highlighted.renderTree).filter(node => node.tagName === 'code');
  assert.equal(codes[1].children[0].value, 'const x = 1\n');
});

test('the extra language pack adds code colors only while enabled', async () => {
  const source = ['~~~go', 'package main', '~~~'].join('\n');
  await loadAdditionalLanguages();
  const core = buildPreviewProjection(source, { highlightCode: true });
  const active = buildPreviewProjection(source, { highlightCode: true, extensions: [extraLanguagesExtension] });
  assert.ok(!elements(core.renderTree).some(node => node.tagName === 'span'));
  assert.ok(elements(active.renderTree).some(node => node.properties.className?.includes('hljs-keyword')));
});
