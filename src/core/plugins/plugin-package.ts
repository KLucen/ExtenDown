import { readPluginArchive } from './plugin-archive.ts';
import { validateScriptPlugin, type ScriptPlugin } from './script-package.ts';
import { validateThemePlugin, type ThemePlugin } from './theme-package.ts';

export { MAX_PLUGIN_PACKAGE_BYTES } from './plugin-archive.ts';

export function readPluginPackage(buffer: ArrayBuffer | Uint8Array): ScriptPlugin | ThemePlugin {
  const archive = readPluginArchive(buffer);
  return archive.kind === 'command' ? validateScriptPlugin(archive) : validateThemePlugin(archive);
}
