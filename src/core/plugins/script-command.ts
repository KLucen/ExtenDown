import { encodeMarkdownBytes, type MarkdownSourceFormat } from '../markdown-source.ts';
import type { ScriptPluginRecord } from './script-store.ts';

export const SCRIPT_PERMISSION_LABELS = {
  'document.read': '读取运行命令时的当前文档源码',
  'document.transform': '提出文档修改供你审阅',
} as const;

export interface ScriptDocument {
  readonly key: number;
  readonly revision: number;
  readonly source: string;
  readonly format: MarkdownSourceFormat;
}

export interface ScriptCommandResult {
  readonly message?: string;
  readonly source?: string;
}

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export function scriptCommandInput(record: ScriptPluginRecord, command: string, document: ScriptDocument | null) {
  const { manifest } = record.current;
  if (!record.enabled || !manifest.contributes.includes(command)) throw new Error('此命令已停用或更新。');
  if (!manifest.permissions.includes('document.read')) return { command };
  if (!document) throw new Error('当前文档暂不可用。');
  return { command, document: { source: document.source, revision: document.revision } };
}

export function scriptCommandResult(value: unknown, record: ScriptPluginRecord, document: ScriptDocument | null): ScriptCommandResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('插件须返回结果对象。');
  const fields = Object.keys(value);
  if (!fields.length || fields.some(name => name !== 'message' && name !== 'source')) throw new Error('插件结果只支持 message 和 source。');
  const { message, source } = value as Record<string, unknown>;
  if (fields.includes('message') && (typeof message !== 'string' || message.length > 2048)) {
    throw new Error('插件回执须为不超过 2048 字符的文本。');
  }
  if (fields.includes('source')) {
    if (!document || !record.enabled || !record.current.manifest.permissions.includes('document.transform')) {
      throw new Error('插件当前没有提出文档修改的权限。');
    }
    if (typeof source !== 'string' || source.length > MAX_DOCUMENT_BYTES || source.includes('\r') ||
      source.includes('\0') || source.startsWith('\uFEFF') || document.format.lineEnding === 'mixed') {
      throw new Error('插件结果须为有效的 LF Markdown 文本，混合换行的文档为只读。');
    }
    const diskSource = document.format.lineEnding === 'crlf' ? source.replaceAll('\n', '\r\n')
      : document.format.lineEnding === 'cr' ? source.replaceAll('\n', '\r') : source;
    if (encodeMarkdownBytes(diskSource, document.format.bomByteLength).byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error('应用后的文档将超过 2 MiB。');
    }
  }
  return { message: message as string | undefined, source: source as string | undefined };
}

export function sameScriptDocument(current: ScriptDocument | null, snapshot: ScriptDocument): boolean {
  return current !== null && current.key === snapshot.key && current.revision === snapshot.revision &&
    current.source === snapshot.source && current.format === snapshot.format;
}
