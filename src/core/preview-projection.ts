import { extensionsFromSnapshot } from './markdown-reading.ts';
import { parseMarkdownSnapshot } from './markdown-snapshot.ts';
import { readingRenderFromSnapshot } from './reading-render.ts';
import { sectionFragmentIds, sectionsFromSnapshot } from './sections.ts';

/** A read-only view of a single exact source version. */
export function buildPreviewProjection(source: string) {
  const snapshot = parseMarkdownSnapshot(source);
  const outline = sectionsFromSnapshot(snapshot);
  const fragments = sectionFragmentIds(outline);
  const headingIds = new Map(outline.sections.map((section, index) => [
    section.headingRange.start - snapshot.bomOffset,
    fragments[index],
  ]));

  return {
    renderTree: readingRenderFromSnapshot(snapshot),
    unsupportedExtensions: extensionsFromSnapshot(snapshot),
    headingIds,
    fragments: new Set(fragments),
  };
}

/** Resolve only same-preview fragments; malformed escapes and other URLs are inert. */
export function resolvePreviewFragment(href: string | undefined, fragments: ReadonlySet<string>): string | null {
  if (!href?.startsWith('#') || href.length === 1) return null;
  try {
    const fragment = decodeURIComponent(href.slice(1));
    return fragments.has(fragment) ? fragment : null;
  } catch {
    return null;
  }
}
