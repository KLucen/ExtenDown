import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreviewProjection, resolvePreviewFragment } from '../src/core/preview-projection.ts';

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
