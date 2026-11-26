import type { Element, ElementContent, Root } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import type { Nodes } from 'mdast';
import type { MarkdownSnapshot } from '../markdown-snapshot.ts';
import { extraLanguagesExtension, mathMarkdownExtension } from './builtin.ts';
import type { MarkdownExtensionContribution } from './contracts.ts';

export interface ReadingOptions {
  readonly extensions?: readonly MarkdownExtensionContribution[];
  readonly highlightCode?: boolean;
}

export function hasMathExtension(options: ReadingOptions): boolean {
  return options.extensions?.some(extension => extension.id === mathMarkdownExtension.id) ?? false;
}

for (const [language, definition] of Object.entries({ bash, css, javascript, json, python, rust, sql, typescript, xml })) {
  hljs.registerLanguage(language, definition);
}

let additionalHighlighter: typeof hljs | undefined;
let additionalLoad: Promise<void> | undefined;

export function loadAdditionalLanguages(): Promise<void> {
  additionalLoad ??= import('./additional-languages.ts').then(module => {
    additionalHighlighter = module.additionalHighlighter;
  }).catch(error => {
    additionalLoad = undefined;
    throw error;
  });
  return additionalLoad;
}

export const READING_EXTENSION_CSS = [
  'math[display="block"]{overflow-x:auto;margin:1em 0}',
  'pre code .hljs-keyword,pre code .hljs-selector-tag,pre code .hljs-literal{color:var(--syntax-keyword,#8b3488);font-weight:600}',
  'pre code .hljs-string,pre code .hljs-attr,pre code .hljs-regexp{color:var(--syntax-string,#146b48)}',
  'pre code .hljs-number,pre code .hljs-built_in,pre code .hljs-title{color:var(--syntax-number,#245e97)}',
  'pre code .hljs-comment,pre code .hljs-meta{color:var(--syntax-comment,#657267);font-style:italic}',
].join('\n');

const MAX_HIGHLIGHT_LENGTH = 40_000;

let mathRenderer: typeof import('./math-engine.ts').renderMath | undefined;
let mathLoad: Promise<void> | undefined;

export function loadMathRenderer(): Promise<void> {
  mathLoad ??= import('./math-engine.ts').then(module => {
    mathRenderer = module.renderMath;
  }).catch(error => {
    mathLoad = undefined;
    throw error;
  });
  return mathLoad;
}

function highlightedNode(node: Root['children'][number] | ElementContent): ElementContent[] {
  if (node.type === 'text') return [{ type: 'text', value: node.value }];
  if (node.type !== 'element') return [];
  const children = node.children.flatMap(highlightedNode);
  if (node.tagName !== 'span') return children;
  const names = node.properties.className;
  const className = Array.isArray(names) ? names.filter(name => /^hljs-[\w-]+$/u.test(String(name))) : [];
  return className.length > 0 ? [{ type: 'element', tagName: 'span', properties: { className }, children }] : children;
}

function highlight(parent: Element, remaining: number, extra: boolean): number {
  const code = parent.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code' || !Array.isArray(code.properties.className)) return 0;
  const className = code.properties.className.find(name => typeof name === 'string' && name.startsWith('language-'));
  const language = typeof className === 'string' ? className.slice('language-'.length).toLowerCase() : '';
  const highlighter = hljs.getLanguage(language) ? hljs : extra ? additionalHighlighter : undefined;
  if (!highlighter?.getLanguage(language) || !code.children.every(child => child.type === 'text')) return 0;
  const source = code.children.map(child => child.value).join('');
  if (source.length > MAX_HIGHLIGHT_LENGTH || source.length > remaining) return 0;
  try {
    const markup = highlighter.highlight(source, { language, ignoreIllegals: true }).value;
    code.children = fromHtml(markup, { fragment: true }).children.flatMap(highlightedNode);
  } catch {
    // Retain the already sanitized code text if a grammar fails.
  }
  return source.length;
}

export function applyReadingExtensions(root: Root, snapshot: MarkdownSnapshot, options: ReadingOptions): Root {
  const equations = new Map<number, { readonly source: string; readonly display: boolean }>();
  if (hasMathExtension(options)) {
    const collect = (node: Nodes): void => {
      if (node.type === 'inlineMath' || node.type === 'math') {
        const offset = node.position?.start.offset;
        if (offset !== undefined) equations.set(offset, { source: node.value, display: node.type === 'math' });
      }
      if ('children' in node) node.children.forEach(collect);
    };
    collect(snapshot.root);
  }
  let mathBudget = 256;
  let highlightBudget = 200_000;
  const extra = options.extensions?.some(extension => extension.id === extraLanguagesExtension.id) ?? false;
  const visit = (parent: Root | Element): void => {
    for (let index = 0; index < parent.children.length; index++) {
      const node = parent.children[index];
      if (node.type !== 'element') continue;
      const offset = node.position?.start.offset;
      const equation = offset === undefined ? undefined : equations.get(offset);
      if (equation && node.tagName === (equation.display ? 'pre' : 'code') && mathBudget-- > 0) {
        const rendered = mathRenderer?.(equation.source, equation.display);
        if (rendered) {
          rendered.position = node.position;
          parent.children[index] = rendered;
          continue;
        }
      }
      if (options.highlightCode && node.tagName === 'pre' && highlightBudget > 0) {
        highlightBudget -= highlight(node, highlightBudget, extra);
      }
      visit(node);
    }
  };
  visit(root);
  return root;
}
