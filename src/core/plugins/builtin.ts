import type { ExportFormat } from '../export/contracts.ts';
import type { MarkdownExtensionContribution, PluginModule } from './contracts.ts';

/** The host recognizes the contribution and owns its KaTeX rendering pipeline. */
export const mathMarkdownExtension: MarkdownExtensionContribution = {
  id: 'org.extendown.markdown.math',
  syntax: 'display-math',
  label: '数学公式',
  detect: source => /(^|\n)\s*\$\$[\s\S]*?^\s*\$\$\s*(?:$|\n)/mu.test(source),
};

export const builtinMathModule: PluginModule = {
  manifest: {
    schemaVersion: 1,
    id: 'org.extendown.markdown.math',
    name: '数学公式',
    version: '1.0.0',
    hostApi: '^1.0.0',
    kind: 'markdown',
    entry: 'builtin/math',
    contributes: [mathMarkdownExtension.id],
    permissions: [],
    dependencies: {},
  },
  activate(registry) {
    registry.register('markdown', mathMarkdownExtension);
  },
};

export const mermaidMarkdownExtension: MarkdownExtensionContribution = {
  id: 'org.extendown.markdown.mermaid',
  syntax: 'mermaid',
  label: 'Mermaid 图表',
  detect: source => /^\s*(?:`{3,}|~{3,})mermaid(?:\s|$)/mu.test(source),
};

export const builtinMermaidModule: PluginModule = {
  manifest: {
    schemaVersion: 1,
    id: mermaidMarkdownExtension.id,
    name: mermaidMarkdownExtension.label,
    version: '1.0.0',
    hostApi: '^1.0.0',
    kind: 'markdown',
    entry: 'builtin/mermaid',
    contributes: [mermaidMarkdownExtension.id],
    permissions: [],
    dependencies: {},
  },
  activate(registry) {
    registry.register('markdown', mermaidMarkdownExtension);
  },
};

export const extraLanguagesExtension: MarkdownExtensionContribution = {
  id: 'org.extendown.markdown.languages',
  syntax: 'code-languages',
  label: '额外代码语言',
  detect: source => /^\s*(?:`{3,}|~{3,})(?:c|c\+\+|cpp|csharp|cs|go|golang|java|lua|markdown|md|powershell|ps1)(?:\s|$)/imu.test(source),
};

export const builtinExtraLanguagesModule: PluginModule = {
  manifest: {
    schemaVersion: 1,
    id: extraLanguagesExtension.id,
    name: extraLanguagesExtension.label,
    version: '1.0.0',
    hostApi: '^1.0.0',
    kind: 'markdown',
    entry: 'builtin/code-languages',
    contributes: [extraLanguagesExtension.id],
    permissions: [],
    dependencies: {},
  },
  activate(registry) {
    registry.register('markdown', extraLanguagesExtension);
  },
};

function exporterModule(format: ExportFormat): PluginModule {
  const id = 'org.extendown.export.' + format;
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name: format.toUpperCase() + ' 导出',
      version: '1.0.0',
      hostApi: '^1.0.0',
      kind: 'exporter',
      entry: 'builtin/export-' + format,
      contributes: [id],
      permissions: ['export.create'],
      dependencies: {},
    },
    activate(registry) {
      registry.register('exporter', { id, format, fileExtensions: format === 'jpg' ? ['jpg', 'jpeg'] : [format] });
    },
  };
}

export const builtinExporterModules: Readonly<Record<ExportFormat, PluginModule>> = {
  html: exporterModule('html'),
  pdf: exporterModule('pdf'),
  png: exporterModule('png'),
  jpg: exporterModule('jpg'),
};
