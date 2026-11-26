import assert from 'node:assert/strict';
import test from 'node:test';
import { exporterFor, exportHtml, renderOfflineHtml } from '../../src/core/export/index.ts';
import { planPdfPages, rasterDimensions } from '../../src/core/export/raster-export.ts';
import { mathMarkdownExtension } from '../../src/core/plugins/builtin.ts';

const snapshot = (source, revision = 7) => ({
  source,
  name: '示例.md',
  revision,
  dialect: 'commonmark-gfm-frontmatter',
});

test('Unicode footnotes and repeated return links resolve in offline HTML alongside GFM alignment', () => {
  const html = renderOfflineHtml(snapshot(
    '正文[^中文]，再次引用[^中文]。\n\n[^中文]: 脚注内容。\n\n| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |',
  ));
  assert.match(html, /<section class="footnotes"><h2>脚注<\/h2>/);
  assert.match(html, /脚注内容/);
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/gu)].map(match => match[1]));
  const links = [...html.matchAll(/ href="#([^"]+)"/gu)];
  assert.equal(links.length, 4);
  for (const [, fragment] of links) assert.ok(ids.has(decodeURIComponent(fragment)), fragment);
  for (const [cell, align] of [['左', 'left'], ['中', 'center'], ['右', 'right']]) {
    assert.ok(html.includes(`<th style="text-align:${align}">${cell}</th>`));
  }
});

test('offline HTML export is deterministic, self-contained, and keeps the document revision', async () => {
  const source = '# 中文标题\n\n**重点**\n\n| A | B |\n| --- | --- |\n| 中文 | 😀 |\n\n```ts\nconst value = 1;\n```\n';
  const first = renderOfflineHtml(snapshot(source));
  const second = renderOfflineHtml(snapshot(source));
  assert.equal(first, second);
  assert.match(first, /^<!doctype html><html lang="zh-CN">/);
  assert.match(first, /<title>示例<\/title>/);
  assert.match(first, /data-revision="7"/);
  assert.match(first, /id="中文标题"/);
  assert.match(first, /<table>/);
  assert.match(first, /<pre><code class="language-ts"><span class="hljs-keyword">const<\/span> value = <span class="hljs-number">1<\/span>;/);
  assert.doesNotMatch(first, /javascript:|<script|onerror|HIDDEN/iu);
  const artifact = await exportHtml(snapshot(source));
  assert.equal(new TextDecoder().decode(artifact.bytes), first);
  assert.equal(artifact.suggestedName, '示例.html');
  assert.equal(artifact.mimeType, 'text/html;charset=utf-8');
});

test('dangerous HTML is represented by the reading sanitizer before export', () => {
  const html = renderOfflineHtml(snapshot('<script>SECRET</script>\n\n<a href="javascript:alert(1)">link</a>\n\n![remote](https://example.invalid/image.png)'));
  assert.doesNotMatch(html, /SECRET|<script|javascript:|onclick|example\.invalid/iu);
  assert.match(html, /不安全的 HTML 内容已隐藏/);
  assert.match(html, /remote（图片未嵌入）/);
});

test('rendered exporters require a browser or WebView layout environment', async () => {
  const exporter = exporterFor('pdf');
  assert.equal(exporter.kind, 'web');
  assert.equal(exporter.available, false);
  await assert.rejects(() => exporter.export(snapshot('# title')), error => {
    assert.equal(error.code, 'native-host-required');
    return true;
  });
});

test('HTML export preserves approved images, math, and highlighted code from the snapshot', async () => {
  const requested = [];
  const resolveImage = async reference => {
    requested.push(reference);
    return reference === 'local.png' ? 'data:image/png;base64,iVBORw0KGgo=' : 'data:image/svg+xml;base64,PHN2Zz4=';
  };
  const source = 'An equation $x^2$.\n\n![local](local.png) ![again](local.png) ![skip](bad.svg) ![remote](https://example.invalid/o.png)\n\n```js\nconst x = 1;\n```';
  const artifact = await exportHtml({ ...snapshot(source), resolveImage, extensions: [mathMarkdownExtension] });
  const html = new TextDecoder().decode(artifact.bytes);
  assert.match(html, /<math[^>]*><semantics>/);
  assert.match(html, /class="hljs-keyword">const/);
  assert.equal(html.match(/src="data:image\/png;base64,iVBORw0KGgo="/g)?.length, 2);
  assert.doesNotMatch(html, /data:image\/svg|example\.invalid/);
  assert.deepEqual(requested, ['local.png', 'bad.svg']);
});

test('pagination covers the complete document and canvas limits fail explicitly', () => {
  assert.deepEqual(planPdfPages(289, 100, [88, 95, 160, 250]), [
    { top: 0, height: 95 }, { top: 95, height: 100 }, { top: 195, height: 94 },
  ]);
  assert.deepEqual(rasterDimensions(900, 3_000, 2), { width: 1_800, height: 6_000 });
  assert.throws(() => rasterDimensions(900, 12_000, 2), { code: 'document-too-large' });
});

test('page cuts skip protected text lines, including wrapped code and inline math', () => {
  assert.deepEqual(planPdfPages(260, 100, [], [
    { top: 90, bottom: 107 },
    { top: 93, bottom: 111 },
    { top: 184, bottom: 205 },
  ]), [
    { top: 0, height: 90 }, { top: 90, height: 94 }, { top: 184, height: 76 },
  ]);
  assert.throws(() => planPdfPages(201, 100, [], [], 2), { code: 'document-too-large' });
});

test('offline HTML preserves in-document anchors and leaves relative links inert', () => {
  const html = renderOfflineHtml(snapshot('# 中文标题\n\n[去这里](#中文标题) · [另一个文档](./private.md) · [外部](https://example.invalid/path)'));
  assert.match(html, /<h1 id="中文标题">/);
  assert.match(html, /href="#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98">去这里/);
  assert.match(html, /<a>另一个文档<\/a>/);
  assert.match(html, /href="https:\/\/example\.invalid\/path">外部/);
});
