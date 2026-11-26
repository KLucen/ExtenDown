import { invoke, isTauri } from '@tauri-apps/api/core';
import { ExportError, type ExportArtifact } from './contracts.ts';

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

export async function saveExportArtifact(artifact: ExportArtifact): Promise<string | null> {
  if (artifact.bytes.byteLength > MAX_EXPORT_BYTES) throw new ExportError('document-too-large', '单个导出文件最大为 64 MiB。');
  if (isTauri()) {
    const metadata = new TextEncoder().encode(`${JSON.stringify({
      format: artifact.format,
      suggestedName: artifact.suggestedName,
      archive: artifact.mimeType === 'application/zip',
    })}\n`);
    const packet = new Uint8Array(metadata.length + artifact.bytes.length);
    packet.set(metadata);
    packet.set(artifact.bytes, metadata.length);
    return invoke<string | null>('save_export', packet);
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(artifact.bytes)], { type: artifact.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = artifact.suggestedName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return artifact.suggestedName;
}
