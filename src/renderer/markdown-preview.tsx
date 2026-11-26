import { useId, useMemo, useRef } from 'react';
import type { ComponentProps } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { buildPreviewProjection, resolvePreviewFragment } from '../core/preview-projection.ts';
import { ReaderMarkdown } from './reader-markdown';

const extensionLabels = {
  'display-math': '数学公式',
  'wiki-link': 'Wiki 链接',
  directive: '指令语法',
} as const;

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
type HeadingProps = ComponentProps<'h1'> & ExtraProps;

/** Read-only, offline preview. File and URL access can be added through an explicit host policy. */
export function MarkdownPreview({ source }: { readonly source: string }) {
  const projection = useMemo(() => buildPreviewProjection(source), [source]);
  const previewId = useId();
  const article = useRef<HTMLElement>(null);

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
      img: ({ alt }) => <span className="image-placeholder" role="img" aria-label={alt || '图片'}>
        {alt || '图片'}（未加载）
      </span>,
      input: ({ type, checked }) => type === 'checkbox' ? <input type="checkbox" checked={checked} disabled readOnly /> : null,
      table: ({ node: _node, children, ...props }) => <div className="table-scroll" role="region" aria-label="表格，可水平滚动" tabIndex={0}>
        <table {...props}>{children}</table>
      </div>,
      pre: ({ node: _node, children, ...props }) => <pre {...props} tabIndex={0} aria-label="代码块，可水平滚动">{children}</pre>,
    };
  }, [previewId, projection]);

  return <article className="markdown-body" aria-label="Markdown 阅读预览" ref={article}>
    {projection.unsupportedExtensions.length > 0 && <p className="preview-note" role="note">
      以下扩展以文本显示：{projection.unsupportedExtensions.map(extension => extensionLabels[extension]).join('、')}
    </p>}
    <ReaderMarkdown tree={projection.renderTree} components={components} />
  </article>;
}
