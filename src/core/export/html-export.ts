import type { Element, Nodes } from 'hast';
import { hasMermaidExtension, MAX_MERMAID_DIAGRAMS, mermaidSource, renderMermaidImage } from '../plugins/mermaid.ts';
import { extraLanguagesExtension } from '../plugins/builtin.ts';
import { hasMathExtension, loadAdditionalLanguages, loadMathRenderer, READING_EXTENSION_CSS } from '../plugins/reading-extensions.ts';
import { buildPreviewProjection } from '../preview-projection.ts';
import {
  ExportError,
  type DocumentSnapshot,
  type ExportArtifact,
  type ExportOptions,
  type PreparedExportDocument,
} from './contracts.ts';

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SAFE_ATTRIBUTE_NAMES = new Set(['alt', 'checked', 'class', 'colspan', 'disabled', 'headers', 'href', 'id', 'lang', 'open', 'role', 'rowspan', 'scope', 'start', 'src', 'title', 'type']);
const MATH_ATTRIBUTE_NAMES = new Set([
  'display', 'encoding', 'xmlns', 'accent', 'accentunder', 'columnalign', 'columnlines', 'columnspacing',
  'displaystyle', 'fence', 'height', 'depth', 'linethickness', 'lspace', 'mathcolor', 'mathsize', 'mathvariant',
  'maxsize', 'minsize', 'movablelimits', 'notation', 'rowalign', 'rowlines', 'rowspacing', 'rspace',
  'scriptlevel', 'separator', 'stretchy', 'symmetric', 'voffset', 'width',
]);
const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon);base64,[\w+/]+={0,2}$/iu;
const MAX_EMBEDDED_IMAGE_CHARACTERS = 32 * 1024 * 1024;

const EXPORT_CSS = `:root{color-scheme:light;--text:#242820;--muted:#646b5e;--border:#d8ddcf;--surface:#fffef8;--code:#f1f4ea}*{box-sizing:border-box}html{background:var(--surface)}body{max-width:72ch;margin:0 auto;padding:48px 28px;color:var(--text);font:16px/1.75 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.6em 0 .55em}h1{font-size:2.2rem}h2{font-size:1.55rem}p{margin:0 0 1rem}a{color:#1769aa;text-underline-offset:3px}blockquote{margin:1rem 0;padding:0 1rem;border-left:3px solid #9aaf91;color:var(--muted)}pre{overflow:auto;margin:1rem 0;padding:1rem;border:1px solid var(--border);border-radius:6px;background:var(--code);font:14px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}code{font:inherit} :not(pre)>code{padding:.1em .3em;border-radius:4px;background:var(--code)}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{padding:.4rem .7rem;border:1px solid var(--border);text-align:left}th{background:var(--code)}img{max-width:100%;height:auto}.table-scroll{overflow-x:auto}.html-placeholder{color:var(--muted)}input[type=checkbox]{accent-color:#305645}`;

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

function attributeName(name: string): string {
  if (name === 'className') return 'class';
  if (name === 'colSpan') return 'colspan';
  if (name === 'rowSpan') return 'rowspan';
  return name;
}

function attributeValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(String).join(' ');
  return null;
}

interface ExportImages {
  readonly local: WeakMap<Element, string>;
  readonly diagrams: WeakMap<Element, string>;
}

function serializeNode(
  node: Nodes,
  headingIds: ReadonlyMap<number, string>,
  images: ExportImages,
  insideMath = false,
): string {
  if (node.type === 'text') return escapeText(node.value);
  if (node.type === 'comment') return '';
  if (node.type === 'root') return node.children.map(child => serializeNode(child, headingIds, images)).join('');
  if (node.type !== 'element') return '';

  const diagram = images.diagrams.get(node);
  if (diagram) return `<img class="mermaid-diagram" src="${escapeAttribute(diagram)}" alt="Mermaid 图表">`;
  const properties = { ...node.properties } as Record<string, unknown>;
  if (node.tagName === 'img') {
    const alt = typeof properties.alt === 'string' && properties.alt ? properties.alt : '图片';
    const data = images.local.get(node);
    if (!data) return `<span class="html-placeholder" role="img">${escapeText(`${alt}（图片未嵌入）`)}</span>`;
    properties.src = data;
  }
  if (/^h[1-6]$/u.test(node.tagName) && node.position?.start.offset !== undefined) {
    const id = headingIds.get(node.position.start.offset);
    if (id) properties.id = id;
  }
  if (node.tagName === 'a' && typeof properties.href === 'string' && !/^(?:#|https?:\/\/|mailto:)/iu.test(properties.href)) {
    delete properties.href;
  }
  const isMath = insideMath || node.tagName === 'math';
  const attributes = Object.entries(properties)
    .map(([name, value]) => {
      const normalized = attributeName(name);
      if (!(isMath ? MATH_ATTRIBUTE_NAMES : SAFE_ATTRIBUTE_NAMES).has(normalized)) return '';
      if (value === true) return ` ${normalized}`;
      const serialized = attributeValue(value);
      return serialized === null ? '' : ` ${normalized}="${escapeAttribute(serialized)}"`;
    })
    .join('');
  if (VOID_ELEMENTS.has(node.tagName)) return `<${node.tagName}${attributes}>`;
  return `<${node.tagName}${attributes}>${node.children.map(child => serializeNode(child, headingIds, images, isMath)).join('')}</${node.tagName}>`;
}

function titleFromSnapshot(snapshot: DocumentSnapshot): string {
  const title = snapshot.name.replace(/\.(?:md|markdown|txt)$/iu, '');
  return title || 'ExtenDown 文档';
}

function prepareExportDocument(snapshot: Readonly<DocumentSnapshot>): PreparedExportDocument {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new ExportError('invalid-options', '导出需要有效的文档修订号。');
  }
  const projection = buildPreviewProjection(snapshot.source, { extensions: snapshot.extensions, highlightCode: true });
  return { root: projection.renderTree, headingIds: projection.headingIds, title: titleFromSnapshot(snapshot), revision: snapshot.revision };
}

function* elements(node: Nodes): Generator<Element> {
  if (node.type === 'element') yield node;
  if ('children' in node) for (const child of node.children) yield* elements(child);
}

async function resolveImages(root: Nodes, snapshot: DocumentSnapshot): Promise<ExportImages> {
  const local = new WeakMap<Element, string>();
  const diagrams = new WeakMap<Element, string>();
  const allowMermaid = typeof document !== 'undefined' && hasMermaidExtension(snapshot);
  if (!snapshot.resolveImage && !allowMermaid) return { local, diagrams };
  let remaining = MAX_EMBEDDED_IMAGE_CHARACTERS;
  let diagramCount = 0;
  const seen = new Map<string, string | null>();
  for (const node of elements(root)) {
    if (remaining <= 0) break;
    if (allowMermaid && diagramCount < MAX_MERMAID_DIAGRAMS) {
      const source = mermaidSource(node);
      if (source) {
        diagramCount++;
        const resolved = await renderMermaidImage(source).catch(() => null);
        if (resolved && resolved.length <= remaining) {
          diagrams.set(node, resolved);
          remaining -= resolved.length;
        }
        continue;
      }
    }
    const source = node.properties.src;
    if (node.tagName !== 'img' || typeof source !== 'string' || !snapshot.resolveImage ||
        /^(?:[a-z][a-z\d+.-]*:|[/\\#])/iu.test(source)) continue;
    if (!seen.has(source)) {
      if (seen.size >= 128) continue;
      const resolved = await snapshot.resolveImage(source).catch(() => null);
      seen.set(source, resolved && resolved.length <= remaining && IMAGE_DATA.test(resolved) ? resolved : null);
    }
    const resolved = seen.get(source);
    if (resolved && resolved.length <= remaining) {
      local.set(node, resolved);
      remaining -= resolved.length;
    }
  }
  return { local, diagrams };
}

export interface ExportContent {
  readonly body: string;
  readonly title: string;
  readonly revision: number;
}

function compileContent(
  document: PreparedExportDocument,
  images: ExportImages = { local: new WeakMap(), diagrams: new WeakMap() },
): ExportContent {
  return {
    body: serializeNode(document.root, document.headingIds, images),
    title: document.title,
    revision: document.revision,
  };
}

export async function prepareExportContent(snapshot: Readonly<DocumentSnapshot>): Promise<ExportContent> {
  await Promise.all([
    hasMathExtension(snapshot) && loadMathRenderer(),
    snapshot.extensions?.some(item => item.id === extraLanguagesExtension.id) && loadAdditionalLanguages(),
  ]);
  const document = prepareExportDocument(snapshot);
  return compileContent(document, await resolveImages(document.root, snapshot));
}

export function exportBackground(options?: Readonly<ExportOptions>): string {
  const color = options?.background ?? '#ffffff';
  if (!/^#[\da-f]{6}$/iu.test(color)) throw new ExportError('invalid-options', '请选择有效的导出背景颜色。');
  return color;
}

export function exportHtmlPage(content: ExportContent, options?: Readonly<ExportOptions>, preview = false): string {
  const title = options?.title?.trim() || content.title;
  const background = exportBackground(options);
  const css = `${EXPORT_CSS}\n${READING_EXTENSION_CSS}\n:root{--surface:${background}} pre{white-space:pre-wrap;overflow-wrap:anywhere} th,td{overflow-wrap:anywhere} .extendown-export{display:flow-root;overflow-wrap:anywhere} .extendown-export>:first-child{margin-top:0}${preview ? ' a{pointer-events:none}' : ''}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeText(title)}</title><style>${css}</style></head><body><main class="extendown-export" data-revision="${content.revision}">${content.body}</main></body></html>`;
}

export function renderOfflineHtml(snapshot: Readonly<DocumentSnapshot>, options?: Readonly<ExportOptions>): string {
  return exportHtmlPage(compileContent(prepareExportDocument(snapshot)), options);
}

export async function exportHtml(snapshot: Readonly<DocumentSnapshot>, options?: Readonly<ExportOptions>): Promise<ExportArtifact> {
  const [{ exportPreparedHtml }, content] = await Promise.all([
    import('./save-html-export.ts'),
    prepareExportContent(snapshot),
  ]);
  return exportPreparedHtml(snapshot, content, options);
}

export function exportFilename(name: string, extension: string): string {
  const stem = name.split(/[/\\]/u).at(-1)?.replace(/\.(?:md|markdown|txt)$/iu, '')
    .replace(/[<>:"|?*\u0000-\u001f]/gu, '_').trim().replace(/[. ]+$/u, '') || 'document';
  const safeStem = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem) ? `_${stem}` : stem;
  return `${[...safeStem].slice(0, 120).join('')}.${extension}`;
}
