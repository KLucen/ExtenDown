import type { PluginModule, ThemeContribution } from './contracts.ts';

export const sampleTheme: ThemeContribution = {
  id: 'org.extendown.theme.midnight',
  name: 'Midnight',
  tokens: {
    surface: '#101216',
    text: '#f5f7fa',
    mutedText: '#a9b0bd',
    accent: '#7db6ff',
    border: '#303743',
    codeSurface: '#171b22',
    fontFamily: 'system-ui, sans-serif',
    readingWidth: '68rem',
  },
};

export const builtinSampleThemeModule: PluginModule = {
  manifest: {
    schemaVersion: 1,
    id: 'org.extendown.theme.midnight',
    name: 'Midnight',
    version: '1.0.0',
    hostApi: '^1.0.0',
    kind: 'theme',
    entry: 'builtin/theme-midnight',
    contributes: [sampleTheme.id],
    permissions: [],
    dependencies: {},
  },
  activate(registry) {
    registry.register('theme', sampleTheme);
  },
};
