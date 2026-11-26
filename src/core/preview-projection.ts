import type { Element, Root } from 'hast';
import { extensionsFromSnapshot } from './markdown-reading.ts';
import { parseMarkdownSnapshot } from './markdown-snapshot.ts';
import { readingRenderFromSnapshot } from './reading-render.ts';
import { sectionFragmentIds, sectionsFromSnapshot } from './sections.ts';
import { applyReadingExtensions, hasMathExtension, type ReadingOptions } from './plugins/reading-extensions.ts';

/** A read-only view of a single exact source version. */
export function buildPreviewProjection(source: string, options: ReadingOptions = {}) {
  const math = hasMathExtension(options);
  const snapshot = parseMarkdownSnapshot(source, { math });
  const outline = sectionsFromSnapshot(snapshot);
  const headingFragments = sectionFragmentIds(outline);
  const headingIds = new Map(outline.sections.map((section, index) => [
    section.headingRange.start - snapshot.bomOffset,
    headingFragments[index],
  ]));
  const renderTree = applyReadingExtensions(readingRenderFromSnapshot(snapshot), snapshot, options);
  const fragments = new Set(headingFragments);
  function collectFootnotes(parent: Root | Element) {
    for (const node of parent.children) {
      if (node.type !== 'element') continue;
      const id = node.properties.id;
      if (typeof id === 'string' && id.startsWith('extendown:note-')) fragments.add(id);
      collectFootnotes(node);
    }
  }
  collectFootnotes(renderTree);

  return {
    snapshot,
    renderTree,
    unsupportedExtensions: extensionsFromSnapshot(snapshot),
    headingIds,
    fragments,
  };
}

/** Resolve only same-preview fragments; malformed escapes and other URLs are inert. */
export function resolvePreviewFragment(href: string | undefined, fragments: ReadonlySet<string>): string | null {
  if (!href?.startsWith('#') || href.length === 1) return null;
  try {
    const encoded = href.slice(1);
    if (fragments.has(encoded)) return encoded;
    const fragment = decodeURIComponent(encoded);
    return fragments.has(fragment) ? fragment : null;
  } catch {
    return null;
  }
}
