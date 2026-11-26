import type { Element, ElementContent } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import katex from 'katex';

const MATH_TAGS = new Set([
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms', 'mfrac', 'msqrt',
  'mroot', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle',
  'mpadded', 'mphantom', 'menclose', 'mmultiscripts', 'mprescripts', 'none',
]);
const MATH_PROPERTIES = new Set([
  'display', 'encoding', 'xmlns', 'accent', 'accentunder', 'columnalign', 'columnlines', 'columnspacing',
  'displaystyle', 'fence', 'height', 'depth', 'linethickness', 'lspace', 'mathcolor', 'mathsize', 'mathvariant',
  'maxsize', 'minsize', 'movablelimits', 'notation', 'rowalign', 'rowlines', 'rowspacing', 'rspace',
  'scriptlevel', 'separator', 'stretchy', 'symmetric', 'voffset', 'width',
]);
const MAX_MATH_LENGTH = 2_000;
const MAX_MATH_NODES = 2_000;

function mathNode(node: ElementContent, depth = 0): ElementContent | undefined {
  if (node.type === 'text') return { type: 'text', value: node.value };
  if (node.type !== 'element' || !MATH_TAGS.has(node.tagName) || depth > 80) return undefined;
  const properties = Object.fromEntries(Object.entries(node.properties).filter(([name, value]) => {
    if (!MATH_PROPERTIES.has(name.toLowerCase()) || typeof value !== 'string' || value.length > 100) return false;
    if (name === 'xmlns') return value === 'http://www.w3.org/1998/Math/MathML';
    if (name === 'encoding') return value === 'application/x-tex';
    return /^[\w.,%#+ -]+$/u.test(value);
  }));
  return {
    type: 'element', tagName: node.tagName, properties,
    children: node.children.flatMap(child => mathNode(child, depth + 1) ?? []),
  };
}

export function renderMath(source: string, displayMode: boolean): Element | undefined {
  if (source.length > MAX_MATH_LENGTH) return undefined;
  try {
    const markup = katex.renderToString(source, {
      output: 'mathml', displayMode, throwOnError: true, trust: false, strict: 'ignore',
      maxExpand: 100, maxSize: 32,
    });
    // KaTeX wraps its MathML in a span. Only transfer the independently
    // allowlisted MathML subtree. Source HTML never goes through this step.
    if (markup.split('<', MAX_MATH_NODES + 1).length > MAX_MATH_NODES) return undefined;
    const wrapper = fromHtml(markup, { fragment: true }).children[0];
    const math = wrapper?.type === 'element' && wrapper.children.find(
      (child): child is Element => child.type === 'element' && child.tagName === 'math',
    );
    const safe = math ? mathNode(math) : undefined;
    return safe?.type === 'element' ? safe : undefined;
  } catch {
    return undefined;
  }
}
