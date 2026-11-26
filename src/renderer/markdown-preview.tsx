import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import type { Element, Root } from 'hast';
import { buildPreviewProjection, resolvePreviewFragment } from '../core/preview-projection.ts';
import { hasMermaidExtension, MAX_MERMAID_DIAGRAMS, mermaidSource, renderMermaidImage } from '../core/plugins/mermaid.ts';
import { READING_EXTENSION_CSS, type ReadingOptions } from '../core/plugins/reading-extensions.ts';
import { ReaderMarkdown } from './reader-markdown';

const extensionLabels = {
  'display-math': '数学公式',
  'wiki-link': 'Wiki 链接',
  directive: '指令语法',
} as const;

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
type HeadingProps = ComponentProps<'h1'> & ExtraProps;

type ImageResolver = (reference: string) => Promise<string | null>;

function previewDiagrams(tree: Root): ReadonlyMap<Element, string> {
  const diagrams = new Map<Element, string>();
  function visit(parent: Root | Element) {
    for (const child of parent.children) {
      if (diagrams.size >= MAX_MERMAID_DIAGRAMS) return;
      if (child.type !== 'element') continue;
      const source = mermaidSource(child);
      if (source) diagrams.set(child, source);
      else visit(child);
    }
  }
  visit(tree);
  return diagrams;
}

function MermaidDiagram({ source, children, ...props }: ComponentProps<'pre'> & { readonly source: string }) {
  const [resolved, setResolved] = useState<{ source: string; url?: string }>();
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void renderMermaidImage(source).then(url => {
        if (active) setResolved({ source, url });
      }, () => {
        if (active) setResolved({ source });
      });
    }, 160);
    return () => { active = false; clearTimeout(timer); };
  }, [source]);
  const result = resolved?.source === source ? resolved : undefined;
  if (result?.url) return <img className="mermaid-diagram" src={result.url} alt="Mermaid 图表" />;
  return <>
    {result && <small className="preview-note">Mermaid 图表无法渲染，已显示源码。</small>}
    <pre {...props}>{children}</pre>
  </>;
}

function PreviewImage({ reference, alt, title, resolveImage }: {
  readonly reference?: string;
  readonly alt?: string;
  readonly title?: string;
  readonly resolveImage?: ImageResolver;
}) {
  const [resolved, setResolved] = useState<{ reference: string; resolver: ImageResolver; url: string }>();
  useEffect(() => {
    if (!reference || !resolveImage || /^(?:[a-z][a-z0-9+.-]*:|\/\/|[\\/])/iu.test(reference)) return;
    let active = true;
    void resolveImage(reference).then(url => {
      if (active && url && /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon);base64,[\w+/]+={0,2}$/u.test(url)) {
        setResolved({ reference, resolver: resolveImage, url });
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [reference, resolveImage]);
  if (resolved && resolved.reference === reference && resolved.resolver === resolveImage) {
    return <img src={resolved.url} alt={alt ?? ''} title={title} loading="lazy" />;
  }
  return <span className="image-placeholder" role="img" aria-label={alt || '图片'}>{alt || '图片'}（未加载）</span>;
}

export function MarkdownPreview({ source, extensions, highlightCode = true, resolveImage }: ReadingOptions & {
  readonly source: string;
  readonly resolveImage?: ImageResolver;
}) {
  const projection = useMemo(() => buildPreviewProjection(source, { extensions, highlightCode }), [source, extensions, highlightCode]);
  const previewId = useId();
  const article = useRef<HTMLElement>(null);
  const diagrams = useMemo(() => hasMermaidExtension({ extensions }) ? previewDiagrams(projection.renderTree) : undefined,
    [extensions, projection]);

  const components = useMemo<Components>(() => {
    const fragmentId = (fragment: string) => `${previewId}-${fragment}`;
    const renderHeading = (Tag: HeadingTag, { node, children, ...props }: HeadingProps) => {
      const offset = node?.position?.start.offset;
      const fragment = offset === undefined ? undefined : projection.headingIds.get(offset);
      return <Tag {...props} id={fragment && fragmentId(fragment)} tabIndex={fragment ? -1 : undefined}>{children}</Tag>;
    };

    return {
      h1: props => renderHeading('h1', props),
      h2: props => renderHeading('h2', props),
      h3: props => renderHeading('h3', props),
      h4: props => renderHeading('h4', props),
      h5: props => renderHeading('h5', props),
      h6: props => renderHeading('h6', props),
      a: ({ href, children }) => {
        const fragment = resolvePreviewFragment(href, projection.fragments);
        if (!fragment) return <span className="preview-link-muted">{children}</span>;
        const anchor = fragmentId(fragment);
        return <a href={`#${encodeURIComponent(anchor)}`} onClick={event => {
          event.preventDefault();
          const target = event.currentTarget.ownerDocument.getElementById(anchor);
          if (!target || !article.current?.contains(target)) return;
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'start' });
        }}>{children}</a>;
      },
      img: ({ src, alt, title }) => <PreviewImage reference={typeof src === 'string' ? src : undefined} alt={alt} title={title} resolveImage={resolveImage} />,
      input: ({ type, checked }) => type === 'checkbox' ? <input type="checkbox" checked={checked} disabled readOnly /> : null,
      table: ({ node: _node, children, ...props }) => <div className="table-scroll" role="region" aria-label="表格，可水平滚动" tabIndex={0}>
        <table {...props}>{children}</table>
      </div>,
      pre: ({ node, children, ...props }) => {
        const source = node ? diagrams?.get(node) : undefined;
        const codeProps = { ...props, tabIndex: 0, 'aria-label': '代码块，可水平滚动' };
        return source ? <MermaidDiagram {...codeProps} source={source}>{children}</MermaidDiagram>
          : <pre {...codeProps}>{children}</pre>;
      },
    };
  }, [diagrams, previewId, projection, resolveImage]);

  return <>
    <style>{READING_EXTENSION_CSS}</style>
    <article className="markdown-body" aria-label="Markdown 阅读预览" ref={article}>
      {projection.unsupportedExtensions.length > 0 && <p className="preview-note" role="note">
        以下扩展以文本显示：{projection.unsupportedExtensions.map(extension => extensionLabels[extension]).join('、')}
      </p>}
      <ReaderMarkdown tree={projection.renderTree} components={components} />
    </article>
  </>;
}
