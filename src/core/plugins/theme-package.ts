import { PLUGIN_API_VERSION, type PluginManifest, type PluginModule, type ThemeContribution, type ThemeTokens } from './contracts.ts';
import { MAX_PLUGIN_PACKAGE_BYTES, readPluginArchive } from './plugin-archive.ts';
import { PluginValidationError, satisfiesPluginVersion, validatePluginManifest, validateThemeContribution } from './validation.ts';

export const MAX_THEME_PACKAGE_BYTES = MAX_PLUGIN_PACKAGE_BYTES;

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
  const archive = readPluginArchive(buffer);
  if (archive.kind !== 'theme') throw new PluginValidationError('主题包需要 theme.json。');
  return validateThemePlugin(archive);
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
