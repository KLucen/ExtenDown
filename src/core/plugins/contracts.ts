import type { ExportFormat } from '../export/contracts.ts';

export const PLUGIN_API_VERSION = '1.0.0' as const;

export type PluginKind = 'theme' | 'markdown' | 'render-mode' | 'importer' | 'exporter' | 'command';
export type PluginPermission = 'document.read' | 'document.transform' | 'export.create' | 'network.fetch';

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hostApi: string;
  readonly kind: PluginKind;
  readonly entry: string;
  readonly contributes: readonly string[];
  readonly commandLabels?: Readonly<Record<string, string>>;
  readonly permissions: readonly PluginPermission[];
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface ThemeTokens {
  readonly surface: string;
  readonly text: string;
  readonly mutedText: string;
  readonly accent: string;
  readonly border: string;
  readonly codeSurface: string;
  readonly fontFamily: string;
  readonly readingWidth: string;
}

export interface ThemeContribution {
  readonly id: string;
  readonly name: string;
  readonly tokens: ThemeTokens;
}

export interface MarkdownExtensionContribution {
  readonly id: string;
  readonly syntax: string;
  readonly label: string;
  readonly detect: (source: string) => boolean;
}

export interface RenderModeContribution {
  readonly id: string;
  readonly label: string;
}

export interface ExporterContribution {
  readonly id: string;
  readonly format: ExportFormat;
  readonly fileExtensions: readonly string[];
}

export interface ImporterContribution {
  readonly id: string;
}

export interface CommandContribution {
  readonly id: string;
  readonly label: string;
}

export interface PluginContributionMap {
  readonly theme: ThemeContribution;
  readonly markdown: MarkdownExtensionContribution;
  readonly 'render-mode': RenderModeContribution;
  readonly importer: ImporterContribution;
  readonly exporter: ExporterContribution;
  readonly command: CommandContribution;
}

export interface Disposable {
  dispose(): void;
}

export interface PluginModule {
  readonly manifest: PluginManifest;
  activate(registry: PluginRegistryLike): void | Disposable | (() => void);
}

export interface PluginRegistryLike {
  register<K extends PluginKind>(kind: K, contribution: PluginContributionMap[K]): Disposable;
}

export interface PluginDiagnostic {
  readonly pluginId: string;
  readonly code: 'manifest-invalid' | 'host-api-incompatible' | 'dependency-missing' | 'dependency-incompatible' | 'contribution-conflict' | 'activation-failed' | 'cleanup-failed';
  readonly message: string;
}
