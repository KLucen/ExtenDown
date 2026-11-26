import type { DocumentSnapshot, ExportArtifact, ExportOptions } from './contracts.ts';
import { exportFilename, exportHtmlPage, type ExportContent } from './html-export.ts';

export function exportPreparedHtml(
  snapshot: Readonly<DocumentSnapshot>,
  content: ExportContent,
  options?: Readonly<ExportOptions>,
): ExportArtifact {
  return {
    format: 'html',
    mimeType: 'text/html;charset=utf-8',
    suggestedName: exportFilename(snapshot.name, 'html'),
    bytes: new TextEncoder().encode(exportHtmlPage(content, options)),
    revision: content.revision,
  };
}
