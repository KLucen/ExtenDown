import { unzipSync } from 'fflate';
import { PluginValidationError } from './validation.ts';

export const MAX_PLUGIN_PACKAGE_BYTES = 512 * 1024;
export const MAX_PLUGIN_MANIFEST_BYTES = 16 * 1024;
export const MAX_PLUGIN_SOURCE_BYTES = 128 * 1024;

const entryLimits = {
  'manifest.json': MAX_PLUGIN_MANIFEST_BYTES,
  'theme.json': 16 * 1024,
  'plugin.js': MAX_PLUGIN_SOURCE_BYTES,
  'preview.png': MAX_PLUGIN_PACKAGE_BYTES,
};
const decoder = new TextDecoder('utf-8', { fatal: true });

type PluginArchive =
  | { readonly kind: 'theme'; readonly manifest: unknown; readonly theme: unknown }
  | { readonly kind: 'command'; readonly manifest: unknown; readonly source: string };

export function readPluginArchive(buffer: ArrayBuffer | Uint8Array): PluginArchive {
  if (buffer.byteLength < 22 || buffer.byteLength > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new PluginValidationError('插件包大小超限或 ZIP 不完整。');
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entrySizes = new Map<string, number>();
  let files: ReturnType<typeof unzipSync>;
  try {
    files = unzipSync(bytes, {
      filter: ({ name, size, originalSize, compression }) => {
        if (!Object.hasOwn(entryLimits, name) || entrySizes.has(name)) {
          throw new PluginValidationError('插件包含未知、重复或位于子目录的文件。');
        }
        const limit = entryLimits[name as keyof typeof entryLimits];
        if (originalSize > limit || size > Math.min(MAX_PLUGIN_PACKAGE_BYTES, limit + 1024) ||
            (compression !== 0 && compression !== 8) || (compression === 0 && size !== originalSize)) {
          throw new PluginValidationError(`插件文件 ${name} 的大小或压缩格式不受支持。`);
        }
        entrySizes.set(name, originalSize);
        // Preview artwork is optional and is never extracted.
        return name !== 'preview.png';
      },
    });
  } catch (error) {
    if (error instanceof PluginValidationError) throw error;
    throw new PluginValidationError('插件包无法解压。');
  }
  const manifestBytes = files['manifest.json'];
  const themeBytes = files['theme.json'];
  const sourceBytes = files['plugin.js'];
  if (!manifestBytes || Boolean(themeBytes) === Boolean(sourceBytes) ||
      (sourceBytes && entrySizes.has('preview.png')) ||
      Object.entries(files).some(([name, content]) => content.byteLength !== entrySizes.get(name))) {
    throw new PluginValidationError('插件包需要 manifest.json 和唯一入口 theme.json 或 plugin.js。');
  }
  try {
    const manifest: unknown = JSON.parse(decoder.decode(manifestBytes));
    return themeBytes
      ? { kind: 'theme', manifest, theme: JSON.parse(decoder.decode(themeBytes)) as unknown }
      : { kind: 'command', manifest, source: decoder.decode(sourceBytes) };
  } catch {
    throw new PluginValidationError('插件包包含无法读取的 UTF-8 文本或 JSON。');
  }
}
