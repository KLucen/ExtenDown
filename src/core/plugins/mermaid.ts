import type { Element } from 'hast';
import { mermaidMarkdownExtension } from './builtin.ts';
import type { ReadingOptions } from './reading-extensions.ts';

export const MAX_MERMAID_DIAGRAMS = 16;
const MAX_SOURCE_LENGTH = 8_000;
const MAX_SVG_BYTES = 512 * 1024;
const cache = new Map<string, Promise<string>>();
let engineRequest: ReturnType<typeof loadEngine> | undefined;
let diagramNumber = 0;

export function hasMermaidExtension(options: ReadingOptions): boolean {
  return options.extensions?.some(extension => extension.id === mermaidMarkdownExtension.id) ?? false;
}

export function mermaidSource(node: Element): string | undefined {
  if (node.tagName !== 'pre') return undefined;
  const code = node.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code' ||
    !Array.isArray(code.properties.className) || !code.properties.className.includes('language-mermaid') ||
    !code.children.every(child => child.type === 'text')) return undefined;
  return code.children.map(child => child.value).join('').trim();
}

async function loadEngine() {
  const { createMermaid } = await import('./mermaid-engine.ts');
  const mermaid = createMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: MAX_SOURCE_LENGTH,
    maxEdges: 160,
    theme: 'neutral',
  });
  return mermaid;
}

async function render(source: string): Promise<string> {
  const mermaid = await (engineRequest ??= loadEngine());
  const { svg } = await mermaid.render(`extendown-diagram-${++diagramNumber}`, source);
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const dimensions = root.getAttribute('viewBox')?.trim().split(/[\s,]+/u).map(Number);
  if (root.localName !== 'svg' || !dimensions || dimensions.length !== 4 ||
    dimensions.some(value => !Number.isFinite(value)) || dimensions[2] <= 0 || dimensions[3] <= 0 ||
    dimensions[2] > 10_000 || dimensions[3] > 10_000) throw new Error('Mermaid 图表尺寸无效。');

  root.setAttribute('width', String(Math.ceil(dimensions[2])));
  root.setAttribute('height', String(Math.ceil(dimensions[3])));
  root.removeAttribute('style');
  const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(root));
  if (bytes.length > MAX_SVG_BYTES) throw new Error('Mermaid 图表超过大小限制。');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  // SVG is displayed as an image in both preview and export, with no document scripting.
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export async function renderMermaidImage(source: string): Promise<string> {
  // The host configuration applies to each diagram, including exported snapshots.
  if (!source || source.length > MAX_SOURCE_LENGTH || /^\s*---/u.test(source) || /%%\s*\{/u.test(source)) {
    throw new Error('Mermaid 图表为空、过长或包含独立配置。');
  }
  const result = cache.get(source) ?? render(source);
  cache.delete(source);
  cache.set(source, result);
  if (cache.size > MAX_MERMAID_DIAGRAMS) cache.delete(cache.keys().next().value!);
  return result;
}
