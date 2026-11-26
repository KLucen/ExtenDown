import type { PluginModule, RenderModeContribution } from './contracts.ts';

export const focusRenderMode: RenderModeContribution = {
  id: 'org.extendown.view.focus',
  label: '专注视图',
};

export const builtinFocusModule: PluginModule = {
  manifest: {
    schemaVersion: 1,
    id: focusRenderMode.id,
    name: focusRenderMode.label,
    version: '1.0.0',
    hostApi: '^1.0.0',
    kind: 'render-mode',
    entry: 'builtin/view-focus',
    contributes: [focusRenderMode.id],
    permissions: [],
    dependencies: {},
  },
  activate(registry) {
    registry.register('render-mode', focusRenderMode);
  },
};
