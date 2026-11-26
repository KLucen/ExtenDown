import { exportHtml } from './html-export.ts';
import { ExportError, type Exporter } from './contracts.ts';

function renderedExporter(format: 'pdf' | 'png' | 'jpg'): Exporter {
  return {
    format,
    kind: 'web',
    get available() { return typeof document !== 'undefined'; },
    async export(snapshot, options) {
      const { exportRendered } = await import('./raster-export.ts');
      return exportRendered(format, snapshot, options);
    },
  };
}

export const htmlExporter: Exporter = {
  format: 'html',
  kind: 'web',
  available: true,
  export: exportHtml,
};

export const pdfExporter = renderedExporter('pdf');
export const pngExporter = renderedExporter('png');
export const jpgExporter = renderedExporter('jpg');

export function builtInExporters(): readonly Exporter[] {
  return [htmlExporter, pdfExporter, pngExporter, jpgExporter];
}

export function exporterFor(format: Exporter['format']): Exporter {
  const exporter = builtInExporters().find(candidate => candidate.format === format);
  if (!exporter) throw new ExportError('unsupported-format', `暂不支持 ${format} 导出。`);
  return exporter;
}
