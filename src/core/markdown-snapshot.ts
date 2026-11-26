import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, 'yaml');
const mathProcessor = processor().use(remarkMath);

/** Parser tree and exact source travel together. Consumers must not mutate the tree. */
export interface MarkdownSnapshot {
  readonly source: string;
  readonly body: string;
  readonly bomOffset: 0 | 1;
  readonly root: Root;
}

export function parseMarkdownSnapshot(source: string, { math = false } = {}): MarkdownSnapshot {
  const bomOffset = source.startsWith('\uFEFF') ? 1 : 0;
  const body = source.slice(bomOffset);
  return { source, body, bomOffset, root: (math ? mathProcessor : processor).parse(body) as Root };
}
