import { unzipSync } from 'fflate';
import { PLUGIN_API_VERSION, type PluginManifest, type PluginModule, type ThemeContribution, type ThemeTokens } from './contracts.ts';
import { PluginValidationError, satisfiesPluginVersion, validatePluginManifest, validateThemeContribution } from './validation.ts';

export const MAX_THEME_PACKAGE_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_COMPRESSED_JSON_BYTES = MAX_JSON_BYTES + 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ThemePlugin {
  readonly manifest: PluginManifest;
  readonly theme: ThemeContribution;
}

export const lightTheme: ThemeTokens = {
  surface: '#ffffff', text: '#202522', mutedText: '#65706a', accent: '#25614d',
  border: '#d8ded9', codeSurface: '#f6f8f6', fontFamily: 'system-ui, sans-serif', readingWidth: '70ch',
};

export function validateThemePlugin(value: unknown): ThemePlugin {
  if (!value || typeof value !== 'object' || !('manifest' in value) || !('theme' in value)) {
    throw new PluginValidationError('主题包需要 manifest.json 和 theme.json。');
  }
  const manifest = validatePluginManifest(value.manifest);
  if (!satisfiesPluginVersion(PLUGIN_API_VERSION, manifest.hostApi)) {
    throw new PluginValidationError('主题包要求的插件 API 与当前应用不兼容。');
  }
  if (
    manifest.kind !== 'theme' || manifest.entry !== 'theme.json' || manifest.permissions.length > 0 ||
    Object.keys(manifest.dependencies).length > 0
  ) {
    throw new PluginValidationError('主题包须以 theme.json 为入口，权限和依赖声明须为空。');
  }
  if (
    !manifest.id.includes('.') || manifest.id.startsWith('org.extendown.') || manifest.id.startsWith('core.') ||
    manifest.contributes.length !== 1 ||
    ![manifest.id, 'theme:' + manifest.id.split('.').at(-1)].includes(manifest.contributes[0])
  ) {
    throw new PluginValidationError('主题包须声明一个与插件 ID 对应的主题贡献，并使用自己的命名空间。');
  }
  const data = value.theme;
  if (!data || typeof data !== 'object' || ('schemaVersion' in data && data.schemaVersion !== 1)) {
    throw new PluginValidationError('theme.json 格式无效。');
  }
  if (!('tokens' in data) || !data.tokens || typeof data.tokens !== 'object' || Array.isArray(data.tokens)) {
    throw new PluginValidationError('主题包缺少有效的 tokens 对象。');
  }
  if ('id' in data && data.id !== manifest.id) throw new PluginValidationError('主题 ID 与 Manifest 不一致。');
  const theme = validateThemeContribution({
    id: manifest.id, name: manifest.name, tokens: { ...lightTheme, ...data.tokens },
  });
  return {
    manifest: { ...manifest, contributes: [manifest.id] },
    theme,
  };
}

export function readThemePlugin(buffer: ArrayBuffer | Uint8Array): ThemePlugin {
  if (buffer.byteLength < 22 || buffer.byteLength > MAX_THEME_PACKAGE_BYTES) {
    throw new PluginValidationError('主题包大小超限或 ZIP 不完整。');
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const seen = new Set<string>();
  let files: ReturnType<typeof unzipSync>;
  try {
    files = unzipSync(bytes, {
      filter: (entry) => {
        const { name, size, originalSize, compression } = entry;
        if (seen.has(name) || !['manifest.json', 'theme.json', 'preview.png'].includes(name)) {
          throw new PluginValidationError('主题包仅支持不重复的 manifest.json、theme.json 和可选 preview.png。');
        }
        seen.add(name);
        const limit = name === 'preview.png' ? MAX_PREVIEW_BYTES : MAX_JSON_BYTES;
        if (
          size > (name === 'preview.png' ? MAX_THEME_PACKAGE_BYTES : MAX_COMPRESSED_JSON_BYTES) || originalSize > limit ||
          (compression !== 0 && compression !== 8) ||
          (compression === 0 && size !== originalSize)
        ) {
          throw new PluginValidationError('主题包的条目大小或压缩格式不受支持。');
        }
        // Preview artwork is optional and never extracted or used as CSS.
        return name !== 'preview.png';
      },
    });
  } catch (error) {
    if (error instanceof PluginValidationError) throw error;
    throw new PluginValidationError('主题包无法解压。');
  }
  const manifestBytes = files['manifest.json'];
  const themeBytes = files['theme.json'];
  if (!manifestBytes || !themeBytes) throw new PluginValidationError('主题包缺少 manifest.json 或 theme.json。');
  try {
    return validateThemePlugin({
      manifest: JSON.parse(decoder.decode(manifestBytes)),
      theme: JSON.parse(decoder.decode(themeBytes)),
    });
  } catch (error) {
    if (error instanceof PluginValidationError) throw error;
    throw new PluginValidationError('主题包包含无法读取的 UTF-8 JSON。');
  }
}

export function createThemeModule(plugin: ThemePlugin): PluginModule {
  const { manifest, theme } = validateThemePlugin(plugin);
  return {
    manifest,
    activate(registry) {
      registry.register('theme', theme);
    },
  };
}

export function themeStyle(tokens: ThemeTokens) {
  return {
    color: tokens.text,
    '--paper': tokens.surface, '--surface': tokens.surface, '--surface-soft': tokens.codeSurface,
    '--surface-muted': tokens.codeSurface, '--text': tokens.text, '--muted': tokens.mutedText,
    '--text-muted': tokens.mutedText, '--accent': tokens.accent, '--green': tokens.accent,
    '--edge': tokens.border, '--border': tokens.border, '--line': tokens.border,
    '--line-strong': tokens.border, '--code-surface': tokens.codeSurface,
    '--reading-font': tokens.fontFamily, '--reading-width': tokens.readingWidth,
  };
}
