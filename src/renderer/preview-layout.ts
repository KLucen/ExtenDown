import type { Root } from 'hast';

function blankGapLines(body: string, from: number, to: number): number {
  const gap = body.slice(from, to);
  return /^[\t \r\n]*$/u.test(gap) ? gap.match(/\r\n|[\r\n]/gu)?.length ?? 0 : 0;
}

/** Supplement Markdown block spacing with extra blank lines from the editor. */
export function buildPreviewLayout(tree: Root, body: string, blankOffset?: number): Root {
  const children = [...tree.children];
  if (blankOffset !== undefined) {
    const index = children.findIndex(child => (child.position?.start.offset ?? -1) >= blankOffset);
    children.splice(index < 0 ? children.length : index, 0, {
      type: 'element', tagName: 'p', properties: { dataEmptyDraft: blankOffset }, children: [],
    });
  }

  const result: Root['children'] = [];
  let previousEnd: number | undefined;
  for (const child of children) {
    const draft = child.type === 'element' && child.properties.dataEmptyDraft;
    const start = typeof draft === 'number' ? draft : child.position?.start.offset;
    const end = typeof draft === 'number' ? draft : child.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      // The standard block margin already represents one separating blank
      // line. The editable empty paragraph itself represents its source line.
      const lines = blankGapLines(body, previousEnd ?? 0, start) - (previousEnd === undefined ? 0 : 2);
      if (lines > 0) {
        result.push({
          type: 'element', tagName: 'div', children: [],
          properties: { ariaHidden: 'true', className: ['preview-blank-lines'], style: `--preview-blank-lines: ${lines}` },
        });
      }
      previousEnd = end;
    }
    result.push(child);
  }
  return result.length === tree.children.length ? tree : { ...tree, children: result };
}
