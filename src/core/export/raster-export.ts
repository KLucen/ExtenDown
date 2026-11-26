import { zipSync } from 'fflate';
import { ExportError, type DocumentSnapshot, type ExportArtifact, type ExportOptions } from './contracts.ts';
import { exportBackground, exportFilename, exportHtmlPage, prepareExportContent, type ExportContent } from './html-export.ts';

const IMAGE_WIDTH = 900;
const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_PIXELS = 22_000_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_IMAGE_SEGMENTS = 100;
const IMAGE_SEGMENT_HEIGHT = 1200;
const MM_TO_PX = 96 / 25.4;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg' } as const;

type RasterFormat = keyof typeof IMAGE_MIME;
type VerticalBand = Readonly<{ top: number; bottom: number }>;

export function rasterDimensions(width: number, height: number, scale: number): { width: number; height: number } {
  const outputWidth = Math.ceil(width * scale);
  const outputHeight = Math.ceil(height * scale);
  if (!Number.isSafeInteger(outputWidth) || !Number.isSafeInteger(outputHeight) || outputWidth < 1 || outputHeight < 1 ||
      outputWidth > MAX_CANVAS_SIDE || outputHeight > MAX_CANVAS_SIDE || outputWidth * outputHeight > MAX_CANVAS_PIXELS) {
    throw new ExportError('document-too-large', '文档超出导出尺寸上限。请选择较低清晰度，或拆分文档后再导出。');
  }
  return { width: outputWidth, height: outputHeight };
}

export function planPdfPages(
  height: number,
  pageHeight: number,
  blockEnds: readonly number[],
  protectedBands: readonly VerticalBand[] = [],
  maxPages = MAX_PDF_PAGES,
): readonly { top: number; height: number }[] {
  const pages: { top: number; height: number }[] = [];
  const bands = mergeBands(protectedBands);
  let top = 0;
  let blockIndex = 0;
  let bandIndex = 0;
  while (top < height) {
    if (pages.length >= maxPages) {
      throw new ExportError('document-too-large', `单份文档最多导出 ${maxPages} 页或分段。请拆分文档后再导出。`);
    }
    const maxBottom = Math.min(top + pageHeight, height);
    let suggestedBottom = 0;
    while (blockIndex < blockEnds.length && blockEnds[blockIndex] <= maxBottom) {
      const end = blockEnds[blockIndex++];
      if (end > top) suggestedBottom = end;
    }
    // Prefer the end of a complete block when it leaves little unused page space.
    const candidate = maxBottom < height && suggestedBottom >= top + pageHeight * 0.72 ? suggestedBottom : maxBottom;
    while (bandIndex < bands.length && bands[bandIndex].bottom <= candidate) bandIndex++;
    const band = bands[bandIndex];
    const bottom = band && band.top < candidate && band.top > top ? band.top : candidate;
    pages.push({ top, height: bottom - top });
    top = bottom;
  }
  return pages;
}

function mergeBands(bands: readonly VerticalBand[]): readonly VerticalBand[] {
  const ordered = [...bands].sort((left, right) => left.top - right.top || left.bottom - right.bottom);
  const merged: { top: number; bottom: number }[] = [];
  for (const band of ordered) {
    const previous = merged.at(-1);
    if (previous && previous.bottom > band.top) previous.bottom = Math.max(previous.bottom, band.bottom);
    else merged.push({ top: band.top, bottom: band.bottom });
  }
  return merged;
}

function textBands(body: HTMLElement, bodyTop: number, pageHeight: number): readonly VerticalBand[] {
  const bands: VerticalBand[] = [];
  const owner = body.ownerDocument;
  const range = owner.createRange();
  const walker = owner.createTreeWalker(body.querySelector('main') ?? body, NodeFilter.SHOW_TEXT);
  const include = (bounds: DOMRect) => {
    if (bounds.height <= 0 || bounds.height >= pageHeight || bounds.width <= 0) return;
    const band = { top: Math.floor(bounds.top - bodyTop), bottom: Math.ceil(bounds.bottom - bodyTop) };
    if (band.bottom > band.top) bands.push(band);
  };
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || node.parentElement?.closest('math')) continue;
    range.selectNodeContents(node);
    for (const bounds of range.getClientRects()) include(bounds);
  }
  for (const item of body.querySelectorAll('img, math')) include(item.getBoundingClientRect());
  return bands;
}

function pageCuts(body: HTMLElement, pageHeight: number, maxPages: number) {
  const bounds = body.getBoundingClientRect();
  const height = Math.max(1, Math.ceil(bounds.height));
  if (height > pageHeight * maxPages) {
    throw new ExportError('document-too-large', `单份文档最多导出 ${maxPages} 页或分段。请拆分文档后再导出。`);
  }
  const blockEnds = Array.from(body.querySelectorAll('main > *'), block =>
    Math.ceil(block.getBoundingClientRect().bottom - bounds.top)).sort((left, right) => left - right);
  return planPdfPages(height, pageHeight, blockEnds, textBands(body, bounds.top, pageHeight), maxPages);
}

function outputScale(options?: Readonly<ExportOptions>): number {
  const scale = options?.scale ?? 2;
  if (scale !== 1 && scale !== 2) throw new ExportError('invalid-options', '清晰度支持 1× 或 2×。');
  return scale;
}

function pdfLayout(options?: Readonly<ExportOptions>) {
  const paper = options?.paper ?? 'a4';
  const orientation = options?.orientation ?? 'portrait';
  const margin = options?.marginMm ?? 12;
  if ((paper !== 'a4' && paper !== 'letter') || (orientation !== 'portrait' && orientation !== 'landscape') ||
      !Number.isFinite(margin) || margin < 5 || margin > 35) {
    throw new ExportError('invalid-options', '请选择有效纸张、方向和 5–35 mm 页边距。');
  }
  const [portraitWidth, portraitHeight] = paper === 'a4' ? [210, 297] : [215.9, 279.4];
  const [widthMm, heightMm] = orientation === 'portrait' ? [portraitWidth, portraitHeight] : [portraitHeight, portraitWidth];
  const contentWidthMm = widthMm - margin * 2;
  const width = Math.floor(contentWidthMm * MM_TO_PX);
  const pageHeight = Math.floor(width * (heightMm - margin * 2) / contentWidthMm);
  return { paper, orientation, margin, contentWidthMm, width, pageHeight };
}

async function withExportPage<T>(
  content: ExportContent,
  width: number,
  padding: number,
  options: Readonly<ExportOptions> | undefined,
  render: (body: HTMLElement) => Promise<T>,
  maxImageHeight?: number,
): Promise<T> {
  if (typeof document === 'undefined') throw new ExportError('native-host-required', '此格式需要浏览器或桌面应用的排版环境。');
  const frame = document.createElement('iframe');
  frame.title = '导出渲染';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin');
  Object.assign(frame.style, {
    position: 'fixed', top: '0', left: '-10000px', width: `${width}px`, height: '800px', border: '0', pointerEvents: 'none',
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    timeout = setTimeout(() => reject(new ExportError('render-failed', '等待导出排版超时。')), 15_000);
  });
  frame.srcdoc = exportHtmlPage(content, options);
  document.body.append(frame);
  try {
    await loaded;
    const childDocument = frame.contentDocument;
    if (!childDocument?.body) throw new ExportError('render-failed', '无法建立导出排版环境。');
    const body = childDocument.body;
    Object.assign(body.style, { maxWidth: 'none', width: `${width}px`, padding: `${padding}px`, margin: '0', backgroundColor: exportBackground(options) });
    childDocument.documentElement.style.overflow = 'hidden';
    await childDocument.fonts.ready;
    for (const image of childDocument.images) {
      try {
        await image.decode();
        if (maxImageHeight) {
          // Preserve the intrinsic proportions while fitting oversized images on one page.
          image.style.maxWidth = `min(100%, ${Math.max(1, Math.floor(maxImageHeight * image.naturalWidth / image.naturalHeight))}px)`;
        }
      } catch {
        const fallback = childDocument.createElement('span');
        fallback.textContent = `${image.alt || '图片'}（图片无法解码）`;
        image.replaceWith(fallback);
      }
    }
    const overflows = [...body.querySelectorAll('pre, table, math')].some(
      element => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1,
    );
    if (body.scrollWidth > width + 1 || overflows) {
      throw new ExportError('document-too-large', '表格、代码或公式超出页面宽度。请缩短内容，或尝试横向 PDF。');
    }
    return await render(body);
  } finally {
    clearTimeout(timeout);
    frame.remove();
  }
}

async function capture(
  body: HTMLElement,
  width: number,
  height: number,
  scale: number,
  background: string,
  top = 0,
): Promise<HTMLCanvasElement> {
  const expected = rasterDimensions(width, height, scale);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(expected.width));
  svg.setAttribute('height', String(expected.height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const content = document.createElementNS(svg.namespaceURI, 'foreignObject');
  content.setAttribute('width', String(width));
  content.setAttribute('height', String(Math.ceil(body.getBoundingClientRect().height)));
  content.setAttribute('y', String(-top));
  const fragment = document.importNode(body, true);
  const stylesheet = body.ownerDocument.querySelector('style');
  if (stylesheet) fragment.prepend(document.importNode(stylesheet, true));
  content.append(fragment);
  svg.append(content);

  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = expected.width;
  canvas.height = expected.height;
  const context = canvas.getContext('2d');
  if (!context) throw new ExportError('render-failed', '无法建立导出画布。');
  context.fillStyle = background;
  context.fillRect(0, 0, expected.width, expected.height);
  context.drawImage(image, 0, 0);
  return canvas;
}

function encodeCanvas(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob?.type === mime) resolve(blob);
      else reject(new ExportError('render-failed', '无法生成所选格式的图像。'));
    }, mime, 0.94);
  });
}

async function captureImage(
  body: HTMLElement,
  format: RasterFormat,
  width: number,
  height: number,
  scale: number,
  background: string,
  top = 0,
): Promise<Uint8Array> {
  const canvas = await capture(body, width, height, scale, background, top);
  try {
    const image = await encodeCanvas(canvas, IMAGE_MIME[format]);
    return new Uint8Array(await image.arrayBuffer());
  } finally {
    canvas.width = 0;
  }
}

async function renderImage(
  content: ExportContent,
  format: RasterFormat,
  options?: Readonly<ExportOptions>,
): Promise<Uint8Array> {
  const scale = outputScale(options);
  const background = exportBackground(options);
  if (options?.splitImages) {
    return withExportPage(content, IMAGE_WIDTH, 36, options, async body => {
      const segments = pageCuts(body, IMAGE_SEGMENT_HEIGHT, MAX_IMAGE_SEGMENTS);
      const files: Record<string, Uint8Array> = {};
      let payloadBytes = 0;
      for (const [index, segment] of segments.entries()) {
        const image = await captureImage(body, format, IMAGE_WIDTH, segment.height, scale, background, segment.top);
        payloadBytes += image.length;
        if (payloadBytes > MAX_OUTPUT_BYTES) {
          throw new ExportError('document-too-large', '分段图片超过 64 MiB。请选择较低清晰度，或拆分文档。');
        }
        files[`page-${String(index + 1).padStart(3, '0')}.${format}`] = image;
      }
      return zipSync(files, { level: 0 });
    }, IMAGE_SEGMENT_HEIGHT - 8);
  }
  return withExportPage(content, IMAGE_WIDTH, 36, options, async body => {
    const height = Math.ceil(body.getBoundingClientRect().height);
    try {
      return await captureImage(body, format, IMAGE_WIDTH, height, scale, background);
    } catch (error) {
      if (error instanceof ExportError && error.code === 'document-too-large') {
        throw new ExportError('document-too-large', '单张图片超出尺寸上限。请降低清晰度或选择分段图片（ZIP）。');
      }
      throw error;
    }
  });
}

async function renderPdf(
  content: ExportContent,
  options?: Readonly<ExportOptions>,
): Promise<Uint8Array> {
  const { createPdf } = await import('./pdf-engine.ts');
  const layout = pdfLayout(options);
  const scale = outputScale(options);
  return withExportPage(content, layout.width, 0, options, async body => {
    const cuts = pageCuts(body, layout.pageHeight, MAX_PDF_PAGES);
    const pdf = createPdf(layout.orientation, layout.paper);
    pdf.setProperties({ title: options?.title?.trim() || content.title, creator: 'ExtenDown' });
    const background = exportBackground(options);
    let imageBytes = 0;
    for (const [index, page] of cuts.entries()) {
      const image = await captureImage(body, 'jpg', layout.width, page.height, scale, background, page.top);
      imageBytes += image.length;
      if (imageBytes > MAX_OUTPUT_BYTES) throw new ExportError('document-too-large', 'PDF 导出超过 64 MiB。请选择较低清晰度，或拆分文档。');
      if (index > 0) pdf.addPage();
      pdf.setFillColor(background);
      pdf.rect(0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight(), 'F');
      pdf.addImage(image, 'JPEG', layout.margin, layout.margin,
        layout.contentWidthMm, page.height * layout.contentWidthMm / layout.width);
    }
    return new Uint8Array(pdf.output('arraybuffer'));
  }, layout.pageHeight - 8);
}

export async function exportRendered(
  format: 'pdf' | RasterFormat,
  snapshot: Readonly<DocumentSnapshot>,
  options?: Readonly<ExportOptions>,
  prepared?: ExportContent,
): Promise<ExportArtifact> {
  if (typeof document === 'undefined') throw new ExportError('native-host-required', '此格式需要浏览器或桌面应用的排版环境。');
  try {
    const content = prepared ?? await prepareExportContent(snapshot);
    const bytes = await (format === 'pdf' ? renderPdf(content, options) : renderImage(content, format, options));
    if (bytes.byteLength > MAX_OUTPUT_BYTES) throw new ExportError('document-too-large', '导出超过 64 MiB。请选择较低清晰度，或拆分文档。');
    const split = format !== 'pdf' && options?.splitImages;
    const filename = exportFilename(snapshot.name, format);
    return {
      format, bytes, suggestedName: split ? `${filename}.zip` : filename, revision: content.revision,
      mimeType: format === 'pdf' ? 'application/pdf' : split ? 'application/zip' : IMAGE_MIME[format],
    };
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError('render-failed', '无法渲染所选导出格式。请检查文档内容后重试。');
  }
}
