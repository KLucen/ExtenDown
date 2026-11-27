import type { PhrasingContent } from 'mdast';
import type { MarkdownSnapshot } from './markdown-snapshot.ts';
import type { PreviewSourcePatch } from './preview-edit.ts';
import { escapeReaderPlainText } from './reader-edit.ts';

export type PreviewInlineText = readonly (string | {
  readonly type: 'strong' | 'emphasis' | 'delete';
  readonly children: PreviewInlineText;
})[];

export function matchesPreviewInline(nodes: readonly PhrasingContent[], text: PreviewInlineText): boolean {
  return nodes.length === text.length && nodes.every((node, index) => {
    const part = text[index];
    if (node.type === 'text') return part === node.value;
    return (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') &&
      typeof part !== 'string' && node.type === part.type && matchesPreviewInline(node.children, part.children);
  });
}

/** Map separately edited visible text nodes to their original Markdown source positions. */
export function patchPreviewInline(snapshot: MarkdownSnapshot, nodes: readonly PhrasingContent[],
  text: PreviewInlineText, math: boolean): PreviewSourcePatch | null {
  const leaves: { from: number; to: number; insert: string }[] = [];
  function collect(original: readonly PhrasingContent[], edited: PreviewInlineText): boolean {
    if (original.length !== edited.length) return false;
    return original.every((node, index) => {
      const part = edited[index];
      if (node.type !== 'text') {
        return (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') &&
          typeof part !== 'string' && node.type === part.type && collect(node.children, part.children);
      }
      if (typeof part !== 'string' || /[\r\n\u0000\uD800-\uDFFF]/u.test(part)) return false;
      if (part === node.value) return true;
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (from === undefined || to === undefined) return false;
      const escaped = escapeReaderPlainText(part);
      leaves.push({ from: from + snapshot.bomOffset, to: to + snapshot.bomOffset,
        insert: math ? escaped.replace(/\$/gu, '\\$') : escaped });
      return true;
    });
  }
  if (!collect(nodes, text) || !leaves.length) return null;
  const { from } = leaves[0];
  const { to } = leaves[leaves.length - 1];
  let end = from;
  const insert = leaves.map(leaf => {
    const raw = snapshot.source.slice(end, leaf.from);
    end = leaf.to;
    return raw + leaf.insert;
  }).join('');
  return { from, to, expected: snapshot.source.slice(from, to), insert };
}
