import { PLUGIN_API_VERSION, type PluginManifest } from './contracts.ts';
import { MAX_PLUGIN_SOURCE_BYTES, readPluginArchive } from './plugin-archive.ts';
import { PluginValidationError, satisfiesPluginVersion, validatePluginManifest } from './validation.ts';

export interface ScriptPlugin {
  readonly manifest: PluginManifest;
  readonly source: string;
}

const encoder = new TextEncoder();

export function validateScriptPlugin(value: unknown): ScriptPlugin {
  if (!value || typeof value !== 'object' || !('manifest' in value) || !('source' in value)) {
    throw new PluginValidationError('命令插件需要 manifest.json 和 plugin.js。');
  }
  const manifest = validatePluginManifest(value.manifest);
  if (!satisfiesPluginVersion(PLUGIN_API_VERSION, manifest.hostApi)) {
    throw new PluginValidationError('命令插件要求的宿主 API 与当前应用不兼容。');
  }
  if (manifest.kind !== 'command' || manifest.entry !== 'plugin.js' || Object.keys(manifest.dependencies).length > 0) {
    throw new PluginValidationError('命令插件须以 plugin.js 为入口，依赖声明须为空。');
  }
  if (!manifest.name.trim() || /[\p{Cc}\p{Bidi_Control}]/u.test(manifest.name)) {
    throw new PluginValidationError('命令插件名称须为可见文本，且不得含控制字符。');
  }
  if (!manifest.id.includes('.') || /^(?:core|org\.extendown)(?:\.|$)/u.test(manifest.id) ||
      manifest.contributes.length > 20 ||
      manifest.contributes.some(id => id !== manifest.id && !id.startsWith(`${manifest.id}.`))) {
    throw new PluginValidationError('命令插件须使用自己的命名空间，并声明最多 20 个本命名空间内的命令。');
  }
  const permissions = new Set(manifest.permissions);
  if (permissions.size !== manifest.permissions.length ||
      manifest.permissions.some(permission => permission !== 'document.read' && permission !== 'document.transform') ||
      (permissions.has('document.transform') && !permissions.has('document.read'))) {
    throw new PluginValidationError('命令插件支持文档读取与文档变换权限。文档变换须同时声明文档读取。');
  }
  const source = value.source;
  if (typeof source !== 'string' || source.length > MAX_PLUGIN_SOURCE_BYTES ||
      source.includes('\0') || !source.trim() || encoder.encode(source).byteLength > MAX_PLUGIN_SOURCE_BYTES) {
    throw new PluginValidationError('plugin.js 须为非空的 UTF-8 JavaScript，大小不得超过 128 KiB。');
  }
  return { manifest, source };
}

export function readScriptPlugin(buffer: ArrayBuffer | Uint8Array): ScriptPlugin {
  const archive = readPluginArchive(buffer);
  if (archive.kind !== 'command') throw new PluginValidationError('命令插件包需要 plugin.js。');
  return validateScriptPlugin(archive);
}
