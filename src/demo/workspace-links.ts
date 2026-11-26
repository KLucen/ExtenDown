import type { Definition, Image, ImageReference, Link, LinkReference, RootContent } from 'mdast';
import { parseMarkdownSnapshot } from '../core/markdown-snapshot.ts';
import { buildPreviewProjection, resolvePreviewFragment } from '../core/preview-projection.ts';

export interface LocalLink {
  label: string;
  path: string;
  fragment: string;
  line: number;
}

export function readLocalLinks(source: string): LocalLink[] {
  const { root } = parseMarkdownSnapshot(source);
  const definitions = new Map<string, string>();
  const references: (Link | Image | LinkReference | ImageReference)[] = [];
  function collect(node: RootContent) {
    if (node.type === 'definition') {
      const definition: Definition = node;
      if (!definitions.has(definition.identifier)) definitions.set(definition.identifier, definition.url);
    }
    if (node.type === 'link' || node.type === 'image' || node.type === 'linkReference' || node.type === 'imageReference') {
      references.push(node);
    }
    if ('children' in node) node.children.forEach(collect);
  }
  root.children.forEach(collect);
  return references.flatMap(node => {
    const label = ('url' in node ? node.url : definitions.get(node.identifier))?.trim();
    if (!label || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(label)) return [];
    const hash = label.indexOf('#');
    const rawPath = hash < 0 ? label : label.slice(0, hash);
    const fragment = hash < 0 ? '' : label.slice(hash + 1);
    return [{ label, path: rawPath.split('?')[0], fragment, line: node.position?.start.line ?? 1 }];
  });
}

export function markdownAnchors(source: string) {
  return buildPreviewProjection(source).fragments;
}

export function hasAnchor(fragment: string, anchors: ReadonlySet<string>): boolean {
  return resolvePreviewFragment('#' + fragment, anchors) !== null;
}

export function offsetAtLine(source: string, line: number): number {
  let offset = 0;
  while (line > 1) {
    const end = source.indexOf('\n', offset);
    if (end === -1) return source.length;
    offset = end + 1;
    line -= 1;
  }
  return offset;
}
