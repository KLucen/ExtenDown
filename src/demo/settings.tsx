import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PluginRegistry, builtinExporterModules, builtinExtraLanguagesModule, builtinMathModule, builtinMermaidModule,
  createThemeModule, themeStyle, validateThemePlugin, type ThemePlugin,
} from '../core/plugins';
import type { PluginModule, ThemeContribution } from '../core/plugins';
import { loadAdditionalLanguages, loadMathRenderer } from '../core/plugins/reading-extensions';
import type { ExportFormat } from '../core/export';
import { errorMessage, type RecoveryDraft } from './document-session';
import { MAX_PLUGIN_PACKAGE_BYTES, readPluginPackage } from '../core/plugins/plugin-package.ts';
import {
  getScriptPlugin, installScriptPlugin, rollbackScriptPlugin, setScriptPluginEnabled, uninstallScriptPlugin,
  type ScriptPluginRecord,
} from '../core/plugins/script-store.ts';
import { permissionDescriptions, type useScriptPlugins } from './script-commands';
import { ShortcutSettings, type useShortcuts } from './commands';
import { useConfirmation } from './confirmation-dialog';
import { UpdateSettings } from './update-settings';
import type { EditorCommand } from '../core/editor-commands';
import { COMPONENT_CATEGORIES, EXTENSION_STATE_LABELS, OFFICIAL_COMPONENTS, matchesComponent,
  type ComponentId, type ComponentCategory, type ExtensionState } from '../core/plugins/component-catalog.ts';
import './draft-settings.css';

const STORE_KEY = 'extendown.extensions.v1';
const FORMATS = ['html', 'pdf', 'png', 'jpg'] as const;
const COMPONENTS = OFFICIAL_COMPONENTS.map(item => item.id);
type Component = ComponentId;
const FULL_COMPONENTS = new Set<Component>(COMPONENTS);
const NO_COMPONENTS = new Set<Component>();
const OFFICIAL_THEME_ID = 'org.extendown.theme.midnight';
let initialComponentSelection: Promise<Component[]> | undefined;

function consumeInitialComponentSelection() {
  initialComponentSelection ??= invoke<Component[]>('consume_initial_component_selection').catch(reason => {
    initialComponentSelection = undefined;
    throw reason;
  });
  return initialComponentSelection;
}
interface OfficialComponentSnapshot {
  readonly revision: number;
  readonly installed: string[];
  readonly pending: string[];
}

type OfficialAction = 'install' | 'uninstall';
interface OfficialOperation { id: Component; action: OfficialAction }

interface RepositoryPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly kind: 'command' | 'theme';
}

const LOADERS = {
  math: () => loadMathRenderer().then(() => builtinMathModule),
  languages: () => loadAdditionalLanguages().then(() => builtinExtraLanguagesModule),
  focus: () => import('../core/plugins/focus-view.ts').then(module => module.builtinFocusModule),
  theme: () => import('../core/plugins/official-theme.ts').then(module => module.builtinSampleThemeModule),
};
type LazyComponent = keyof typeof LOADERS;
const DARK_THEME: ThemeContribution = {
  id: 'core.dark', name: '深色',
  tokens: {
    surface: '#1b211f', text: '#e5ece8', mutedText: '#a8b7ae', accent: '#86ceae',
    border: '#3a4942', codeSurface: '#26322d', fontFamily: 'system-ui, sans-serif', readingWidth: '70ch',
  },
};
type ThemePackage = ThemePlugin;

interface Preferences {
  math: boolean;
  mermaid: boolean;
  languages: boolean;
  presentation: boolean;
  formats: ExportFormat[];
  theme: string;
  packages: ThemePackage[];
  disabledThemes: string[];
}

const DEFAULTS: Preferences = {
  math: true, mermaid: true, languages: true, presentation: true,
  formats: [...FORMATS], theme: 'core.light', packages: [], disabledThemes: [],
};

function readPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Preferences> | null;
    if (!stored || typeof stored !== 'object') return DEFAULTS;
    const packages: ThemePackage[] = [];
    if (Array.isArray(stored.packages)) {
      for (const candidate of stored.packages.slice(0, 40)) {
        try { packages.push(validateThemePlugin(candidate)); } catch { /* Corrupt entries stay disabled. */ }
      }
    }
    return {
      math: stored.math !== false,
      mermaid: stored.mermaid !== false,
      languages: stored.languages !== false,
      presentation: stored.presentation !== false,
      formats: Array.isArray(stored.formats) ? FORMATS.filter(format => stored.formats?.includes(format)) : [...FORMATS],
      theme: typeof stored.theme === 'string' ? stored.theme : DEFAULTS.theme,
      packages,
      disabledThemes: Array.isArray(stored.disabledThemes) ? stored.disabledThemes.filter(value => typeof value === 'string') : [],
    };
  } catch {
    return DEFAULTS;
  }
}

function isNewerVersion(candidate: string, installed: string): boolean {
  const [major, minor, patch] = candidate.split('.').map(Number);
  const [oldMajor, oldMinor, oldPatch] = installed.split('.').map(Number);
  return major > oldMajor || major === oldMajor && (minor > oldMinor || minor === oldMinor && patch > oldPatch);
}

export function useExtensions() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [componentSnapshot, setComponentSnapshot] = useState<OfficialComponentSnapshot | null | undefined>(
    () => isTauri() ? undefined : null,
  );
  const [automaticDownloads, setAutomaticDownloads] = useState<ReadonlySet<Component>>(NO_COMPONENTS);
  const [loaded, setLoaded] = useState<Partial<Record<LazyComponent, PluginModule>>>({});
  const [extensionError, setExtensionError] = useState('');
  const components = useMemo(() => componentSnapshot === null ? FULL_COMPONENTS : componentSnapshot
    ? new Set(COMPONENTS.filter(id => componentSnapshot.installed.includes(id))) : NO_COMPONENTS, [componentSnapshot]);
  const pendingComponents = useMemo(() => new Set(componentSnapshot?.pending), [componentSnapshot]);
  const officialThemeEnabled = !preferences.disabledThemes.includes(OFFICIAL_THEME_ID);
  function acceptComponentSnapshot(snapshot: OfficialComponentSnapshot | null) {
    setComponentSnapshot(previous => previous && (!snapshot || previous.revision >= snapshot.revision) ? previous : snapshot);
  }

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    const subscription = listen<OfficialComponentSnapshot>('official-components-changed', ({ payload }) => {
      if (active) acceptComponentSnapshot(payload);
    }).catch(() => undefined);
    void subscription.then(async () => {
      const result = await invoke<OfficialComponentSnapshot | null>('installed_components');
      if (!active) return;
      acceptComponentSnapshot(result);
      if (!result) return;
      const selected = await consumeInitialComponentSelection();
      if (!active) return;
      setAutomaticDownloads(new Set(selected));
      for (const id of selected) {
        try {
          acceptComponentSnapshot(await invoke<OfficialComponentSnapshot>('install_official_component', { componentId: id }));
        } catch {
          if (active) setExtensionError('部分安装器所选扩展未能下载，可在插件设置中重试。');
        } finally {
          if (active) setAutomaticDownloads(previous => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
        }
      }
    }).catch(() => {
      if (active) setExtensionError('无法读取桌面版已安装组件。');
    });
    return () => {
      active = false;
      void subscription.then(unlisten => unlisten?.());
    };
  }, []);

  async function changeComponent(id: Component, action: OfficialAction) {
    const command = action === 'install' ? 'install_official_component' : 'uninstall_official_component';
    acceptComponentSnapshot(await invoke<OfficialComponentSnapshot>(command, { componentId: id }));
    setExtensionError('');
  }

  useEffect(() => {
    let active = true;
    const desired: Readonly<Record<LazyComponent, boolean>> = {
      math: preferences.math,
      languages: preferences.languages,
      focus: preferences.presentation,
      theme: officialThemeEnabled,
    };
    for (const key of Object.keys(LOADERS) as LazyComponent[]) {
      if (!components.has(key) || !desired[key] || loaded[key]) continue;
      void LOADERS[key]().then(module => {
        if (active) setLoaded(previous => ({ ...previous, [key]: module }));
      }, () => {
        if (active) setExtensionError('无法加载部分扩展。请重新安装对应组件。');
      });
    }
    return () => { active = false; };
  }, [components, preferences.math, preferences.languages, preferences.presentation, officialThemeEnabled, loaded]);
  useEffect(() => {
    function refresh(event: StorageEvent) {
      if (event.key === STORE_KEY) setPreferences(readPreferences());
    }
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);

  function update(change: (current: Preferences) => Preferences) {
    const next = change(readPreferences());
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
    setPreferences(next);
  }

  const registry = useMemo(() => {
    const registry = new PluginRegistry();
    if (components.has('math') && preferences.math && loaded.math) registry.activate(loaded.math);
    if (components.has('mermaid') && preferences.mermaid) registry.activate(builtinMermaidModule);
    if (components.has('languages') && preferences.languages && loaded.languages) registry.activate(loaded.languages);
    if (components.has('focus') && preferences.presentation && loaded.focus) registry.activate(loaded.focus);
    for (const format of preferences.formats) {
      if (components.has(componentForFormat(format))) registry.activate(builtinExporterModules[format]);
    }
    if (components.has('theme') && officialThemeEnabled && loaded.theme) registry.activate(loaded.theme);
    for (const item of preferences.packages) {
      if (!preferences.disabledThemes.includes(item.manifest.id)) registry.activate(createThemeModule(item));
    }
    return registry;
  }, [preferences, components, loaded, officialThemeEnabled]);

  const { themes, markdown, formats, focusAvailable } = useMemo(() => {
    const exporters = new Set(registry.list('exporter').map(item => item.format));
    return {
      themes: registry.list('theme'),
      markdown: registry.list('markdown'),
      formats: FORMATS.filter(format => exporters.has(format)),
      focusAvailable: registry.list('render-mode').some(item => item.id === 'org.extendown.view.focus'),
    };
  }, [registry]);
  const selectedTheme = preferences.theme === DARK_THEME.id ? DARK_THEME : themes.find(theme => theme.id === preferences.theme);
  const style = selectedTheme ? themeStyle(selectedTheme.tokens) : undefined;

  function install(item: ThemePackage) {
    if (!item.manifest.id.startsWith('org.') && !item.manifest.id.includes('.')) throw new Error('插件 ID 必须使用命名空间。');
    if (item.manifest.id.startsWith('org.extendown.') || item.theme.id.startsWith('core.')) throw new Error('此插件 ID 由 ExtenDown 保留。');
    const existing = preferences.packages.find(plugin => plugin.manifest.id === item.manifest.id);
    if (existing && !isNewerVersion(item.manifest.version, existing.manifest.version)) throw new Error('请选择版本更新的主题包。');
    if (!existing && preferences.packages.length >= 40) throw new Error('主题包数量已达上限。');
    const probe = new PluginRegistry();
    for (const other of preferences.packages) {
      if (other.manifest.id !== item.manifest.id) probe.activate(createThemeModule(other));
    }
    if (!probe.activate(createThemeModule(item))) throw new Error(probe.diagnosticsSnapshot().at(-1)?.message ?? '主题无法启用。');
    update(current => ({
      ...current, theme: item.theme.id,
      packages: [...current.packages.filter(plugin => plugin.manifest.id !== item.manifest.id), item],
      disabledThemes: current.disabledThemes.filter(id => id !== item.manifest.id),
    }));
  }

  return {
    preferences, update, registry, themes, style, dark: selectedTheme?.id === DARK_THEME.id || selectedTheme?.id === 'org.extendown.theme.midnight',
    markdown, formats, focusAvailable, components, pendingComponents, automaticDownloads, extensionError,
    componentsReady: componentSnapshot !== undefined, canManageComponents: componentSnapshot != null,
    install, changeComponent,
  };
}

function componentForFormat(format: ExportFormat): Component {
  return format === 'png' || format === 'jpg' ? 'images' : format;
}

type Extensions = ReturnType<typeof useExtensions>;

function officialEnabled(prefs: Preferences, id: Component, format?: ExportFormat): boolean {
  if (id === 'focus') return prefs.presentation;
  if (id === 'theme') return !prefs.disabledThemes.includes(OFFICIAL_THEME_ID);
  if (id === 'math' || id === 'mermaid' || id === 'languages') return prefs[id];
  return format ? prefs.formats.includes(format) : prefs.formats.includes('png') || prefs.formats.includes('jpg');
}

function toggleOfficial(prefs: Preferences, id: Component, enabled: boolean, format?: ExportFormat): Preferences {
  if (id === 'focus') return { ...prefs, presentation: enabled };
  if (id === 'theme') return { ...prefs, disabledThemes: enabled
    ? prefs.disabledThemes.filter(item => item !== OFFICIAL_THEME_ID)
    : [...new Set([...prefs.disabledThemes, OFFICIAL_THEME_ID])] };
  if (id === 'math' || id === 'mermaid' || id === 'languages') return { ...prefs, [id]: enabled };
  return { ...prefs, formats: FORMATS.filter(item => (format ? item === format : componentForFormat(item) === id)
    ? enabled : prefs.formats.includes(item)) };
}

interface PluginFilter {
  query: string;
  category: 'all' | ComponentCategory;
  state: 'all' | Exclude<ExtensionState, 'loading'>;
}

function Components({ plugins, filter, operation, onChange }: {
  plugins: Extensions;
  filter: PluginFilter;
  operation: OfficialOperation | null;
  onChange: (id: Component, action: OfficialAction) => void;
}) {
  const choices = OFFICIAL_COMPONENTS.flatMap(item => {
    const installed = plugins.components.has(item.id);
    const formats: readonly (ExportFormat | undefined)[] = item.id === 'images' && installed ? ['png', 'jpg'] : [undefined];
    return formats.map(format => {
      const enabled = officialEnabled(plugins.preferences, item.id, format ?? (item.id === 'html' || item.id === 'pdf' ? item.id : undefined));
      const state: ExtensionState = !plugins.componentsReady ? 'loading' : !installed ? 'missing' : enabled ? 'enabled' : 'disabled';
      const label = format ? format.toUpperCase() + ' 导出' : item.name;
      const pending = plugins.pendingComponents.has(item.id);
      const status = pending ? '需重新下载' : installed ? (enabled ? '已安装 · 已启用' : '已安装 · 已停用') : '未安装';
      const downloading = plugins.automaticDownloads.has(item.id);
      return { ...item, format, label, installed, enabled, state, pending, status, downloading };
    });
  }).filter(item => (filter.category === 'all' || item.category === filter.category) &&
    (filter.state === 'all' || filter.state === item.state) &&
    matchesComponent(filter.query, item.label, item.name, item.aliases, item.id, item.description));

  return <>
    {Object.entries(COMPONENT_CATEGORIES).map(([category, name]) => {
      const items = choices.filter(item => item.category === category);
      return items.length > 0 && <fieldset className="component-options" key={category}>
        <legend>{name}</legend>
        {items.map(item => <div className="component-choice" key={item.format ?? item.id}>
          <label>
            {item.installed && <input type="checkbox" checked={item.enabled} onChange={event => {
              const enabled = event.target.checked;
              plugins.update(state => toggleOfficial(state, item.id, enabled, item.format));
            }} />}
            <span><strong>{item.label}</strong> <small>{item.status}</small><small>{item.description}</small></span>
          </label>
          {plugins.canManageComponents && <div className="component-actions">
            {!item.installed && <button type="button" className="setting-action" disabled={operation !== null || item.downloading}
              aria-label={'下载并安装 ' + item.label} onClick={() => onChange(item.id, 'install')}>
              {item.downloading || operation?.id === item.id && operation.action === 'install' ? '正在下载…' : '下载并安装'}
            </button>}
            {item.installed && item.format !== 'jpg' &&
              <button type="button" className="setting-action" disabled={operation !== null}
                aria-label={'卸载 ' + item.name} onClick={() => onChange(item.id, 'uninstall')}>
                {operation?.id === item.id && operation.action === 'uninstall' ? '正在卸载…' : '卸载'}
              </button>}
          </div>}
        </div>)}
      </fieldset>;
    })}
    {plugins.extensionError && <p className="error" role="alert">{plugins.extensionError}</p>}
  </>;
}

const SETTINGS_TABS = {
  general: '常规', plugins: '插件', shortcuts: '快捷键', drafts: '草稿',
} as const;
export type SettingsTab = keyof typeof SETTINGS_TABS;

export function Settings({ desktop, plugins, scripts, drafts, draftBusy = false, draftError, onRestoreDraft, onDiscardDraft,
  onClose, launchDefaults, shortcuts, commands, onRunPluginCommand, initialTab = 'general', pluginQuery = '' }: {
  desktop: boolean;
  plugins: Extensions;
  scripts: ReturnType<typeof useScriptPlugins>;
  drafts: RecoveryDraft[];
  draftBusy?: boolean;
  draftError?: string;
  onRestoreDraft: (id: string) => Promise<unknown>;
  onDiscardDraft: (id: string) => Promise<void>;
  onClose: () => void;
  launchDefaults: () => Promise<{ supported: boolean; requested: boolean; message: string }>;
  shortcuts: ReturnType<typeof useShortcuts>;
  commands: readonly EditorCommand[];
  onRunPluginCommand: (id: string) => void;
  initialTab?: SettingsTab;
  pluginQuery?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [packageBusy, setPackageBusy] = useState(false);
  const [repositoryPlugins, setRepositoryPlugins] = useState<RepositoryPlugin[]>();
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const [repositoryError, setRepositoryError] = useState('');
  const [componentOperation, setComponentOperation] = useState<OfficialOperation | null>(null);
  const [componentFeedback, setComponentFeedback] = useState<{ message: string; error?: boolean }>();
  const [tab, setTab] = useState(initialTab);
  const [filter, setFilter] = useState<PluginFilter>({ query: pluginQuery, category: 'all', state: 'all' });
  const confirmation = useConfirmation();
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function changeOfficial(id: Component, action: OfficialAction) {
    if (componentOperation) return;
    const name = OFFICIAL_COMPONENTS.find(component => component.id === id)?.name ?? id;
    if (action === 'uninstall' && !await confirmation.confirm({
      title: '卸载组件',
      description: `卸载「${name}」。之后可从插件页重新安装。`,
      confirmLabel: '卸载',
      variant: 'danger',
    })) return;
    const label = action === 'install' ? '安装' : '卸载';
    setComponentFeedback(undefined);
    setComponentOperation({ id, action });
    try {
      await plugins.changeComponent(id, action);
      setComponentFeedback({ message: `已${label} ${name}。` });
    } catch (reason) {
      setComponentFeedback({ message: errorMessage(reason, `无法${label} ${name}。`), error: true });
    } finally {
      setComponentOperation(null);
    }
  }

  async function install(buffer: ArrayBuffer | Uint8Array, expected?: RepositoryPlugin) {
    setStatus('');
    setError('');
    try {
      const item = readPluginPackage(buffer);
      if (expected && (item.manifest.id !== expected.id || item.manifest.version !== expected.version ||
        item.manifest.kind !== expected.kind)) throw new Error('插件包与 GitHub 目录中的信息不一致。');
      if ('source' in item) {
        const previous = await getScriptPlugin(item.manifest.id);
        if (previous && !await confirmation.confirm({
          title: '更新插件',
          description: `将「${item.manifest.name}」更新到 ${item.manifest.version}。更新后需重新启用，可从插件列表回滚。`,
          confirmLabel: '更新',
        })) return;
        await installScriptPlugin(item, previous?.current.manifest.version ?? null, previous?.generation);
        setStatus(`已安装 ${item.manifest.name} ${item.manifest.version}。请在列表中启用此版本。`);
      } else {
        plugins.install(item);
        setStatus('已安装 ' + item.manifest.name);
      }
    } catch (reason) {
      setError(errorMessage(reason, '无法安装插件包。'));
    }
  }

  async function listRepositoryPlugins() {
    setRepositoryLoading(true);
    setRepositoryError('');
    try {
      setRepositoryPlugins(await invoke<RepositoryPlugin[]>('list_repository_plugins'));
    } catch (reason) {
      setRepositoryError(errorMessage(reason, '无法读取 GitHub 插件目录。'));
    } finally {
      setRepositoryLoading(false);
    }
  }

  async function installRepositoryPlugin(item: RepositoryPlugin) {
    setPackageBusy(true);
    setRepositoryError('');
    setError('');
    setStatus('');
    try {
      const bytes = await invoke<number[]>('download_repository_plugin', { id: item.id, version: item.version });
      await install(new Uint8Array(bytes), item);
    } catch (reason) {
      setRepositoryError(errorMessage(reason, '无法从 GitHub 下载插件。'));
    } finally {
      setPackageBusy(false);
    }
  }

  async function choosePlugin() {
    if (!desktop) {
      fileInput.current?.click();
      return;
    }
    setPackageBusy(true);
    try {
      const bytes = await invoke<number[] | null>('open_plugin_package');
      if (bytes) await install(new Uint8Array(bytes).buffer);
    } catch (reason) {
      setError(errorMessage(reason, '无法打开插件文件。'));
    } finally {
      setPackageBusy(false);
    }
  }

  async function changeScript(record: ScriptPluginRecord, action: 'toggle' | 'rollback' | 'remove') {
    const { id, name, version } = record.current.manifest;
    if (action === 'toggle' && !record.enabled) {
      const permissions = permissionDescriptions(record.current);
      if (!await confirmation.confirm({
        title: '启用插件',
        description: <>
          <p>启用「{name}」{version}。</p>
          {permissions.length ? <ul>{permissions.map(permission => <li key={permission}>{permission}</li>)}</ul>
            : <p>此插件不请求文档权限。</p>}
        </>,
        confirmLabel: '启用',
      })) return;
    }
    if (action === 'rollback' && (!record.previous || !await confirmation.confirm({
      title: '回滚插件',
      description: `将「${name}」回滚到 ${record.previous.manifest.version}。回滚后需重新启用。`,
      confirmLabel: '回滚',
    }))) return;
    if (action === 'remove' && !await confirmation.confirm({
      title: '卸载插件',
      description: `卸载「${name}」及其回滚版本。`,
      confirmLabel: '卸载',
      variant: 'danger',
    })) return;
    setPackageBusy(true);
    setError('');
    setStatus('');
    try {
      if (action === 'toggle') {
        await setScriptPluginEnabled(id, version, !record.enabled, record.generation);
        setStatus(record.enabled ? `已停用 ${name}。` : `已启用 ${name}。可在下方点击命令名称运行。`);
      } else if (action === 'rollback' && record.previous) {
        await rollbackScriptPlugin(id, version, record.previous.manifest.version, record.generation);
        setStatus(`已回滚 ${name}。请在列表中启用该版本。`);
      } else if (action === 'remove') {
        await uninstallScriptPlugin(id, version, record.generation);
        setStatus(`已卸载 ${name}。`);
      }
    } catch (reason) {
      setError(errorMessage(reason, '无法更新插件状态。'));
    } finally {
      setPackageBusy(false);
    }
  }

  async function defaults() {
    setError('');
    try { setStatus((await launchDefaults()).message); }
    catch (reason) { setError(errorMessage(reason, '无法打开系统默认应用设置。')); }
  }

  function toggleTheme(id: string, enabled: boolean) {
    plugins.update(state => ({
      ...state,
      disabledThemes: enabled ? state.disabledThemes.filter(item => item !== id) : [...state.disabledThemes, id],
    }));
  }

  function removeTheme(id: string) {
    plugins.update(state => ({
      ...state, packages: state.packages.filter(item => item.manifest.id !== id),
      disabledThemes: state.disabledThemes.filter(item => item !== id),
    }));
  }

  async function discardDraft(draft: RecoveryDraft) {
    if (draftBusy || !await confirmation.confirm({
      title: '移除恢复草稿',
      description: `移除「${draft.name}」的恢复草稿。草稿里的未保存更改会丢失。`,
      confirmLabel: '移除草稿',
      variant: 'danger',
    })) return;
    await onDiscardDraft(draft.id);
  }

  const selectedTheme = [DARK_THEME, ...plugins.themes].some(theme => theme.id === plugins.preferences.theme)
    ? plugins.preferences.theme : 'core.light';
  const visibleThemes = plugins.preferences.packages.filter(item =>
    (filter.category === 'all' || filter.category === 'appearance') &&
    (filter.state === 'all' || filter.state === (plugins.preferences.disabledThemes.includes(item.manifest.id) ? 'disabled' : 'enabled')) &&
    matchesComponent(filter.query, item.manifest.name, item.manifest.id, '主题 theme'));
  const visibleScripts = scripts.records.filter(record =>
    (filter.category === 'all' || filter.category === 'command') &&
    (filter.state === 'all' || filter.state === (record.enabled ? 'enabled' : 'disabled')) &&
    matchesComponent(filter.query, record.current.manifest.name, record.current.manifest.id, ...record.current.manifest.contributes));
  const visibleRepositoryPlugins = repositoryPlugins?.flatMap(item => {
    const script = scripts.records.find(record => record.current.manifest.id === item.id);
    const theme = plugins.preferences.packages.find(pkg => pkg.manifest.id === item.id);
    const installed = item.kind === 'command' ? script?.current.manifest.version : theme?.manifest.version;
    const enabled = item.kind === 'command' ? script?.enabled : theme && !plugins.preferences.disabledThemes.includes(item.id);
    const state: ExtensionState = !installed ? 'missing' : enabled ? 'enabled' : 'disabled';
    const category = item.kind === 'command' ? 'command' : 'appearance';
    return (filter.category === 'all' || filter.category === category) &&
      (filter.state === 'all' || filter.state === state) &&
      matchesComponent(filter.query, item.name, item.description, item.id)
      ? [{ ...item, installed, state, available: !installed || isNewerVersion(item.version, installed) }] : [];
  });
  return <>
  <dialog className="settings-modal" ref={dialog} aria-labelledby="settings-title" onClose={onClose}>
    <div className="modal-head"><h2 id="settings-title">设置</h2>
      <button type="button" aria-label="关闭设置" onClick={() => dialog.current?.close()}>×</button>
    </div>
    <div className="settings-tabs" role="group" aria-label="设置类别">
      {(Object.entries(SETTINGS_TABS) as [SettingsTab, string][]).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}
    </div>
    {tab === 'general' ? <>
      <section className="settings-section">
        <label className="setting-field">外观<select value={selectedTheme} onChange={event => {
          const theme = event.target.value;
          plugins.update(state => ({ ...state, theme }));
        }}>
          <option value="core.light">浅色</option>
          {[DARK_THEME, ...plugins.themes].map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
        </select></label>
      </section>
      <section className="settings-section">
        <h3>默认应用</h3>
        <p>安装 ExtenDown 后，可在 Windows“默认应用”中搜索 .md 或 .markdown，并选择要使用的程序。</p>
        {desktop && <button className="setting-action" type="button" onClick={defaults}>选择 .md 默认应用</button>}
      </section>
      <UpdateSettings desktop={desktop} />
    </> : tab === 'drafts' ? <section className="settings-section draft-settings" aria-labelledby="draft-settings-title"
      aria-busy={draftBusy || undefined}>
      <h3 id="draft-settings-title">恢复草稿</h3>
      {draftError && <p role="alert" className="draft-settings-error">{draftError}</p>}
      {drafts.length > 0 ? <ul className="draft-list">
        {drafts.map(draft => <li key={draft.id} className="draft-row">
          <div className="draft-file">
            <strong title={draft.name}>{draft.name}</strong>
            <small title={draft.path ?? undefined}>{draft.path ?? '未关联文件'}</small>
          </div>
          <div className="draft-actions">
            <button type="button" className="setting-action" disabled={draftBusy}
              aria-label={`恢复 ${draft.name}`} onClick={() => void onRestoreDraft(draft.id)}>恢复</button>
            <button type="button" className="setting-action draft-remove" disabled={draftBusy}
              aria-label={`移除 ${draft.name}`} onClick={() => void discardDraft(draft)}>移除</button>
          </div>
        </li>)}
      </ul> : <p>{desktop ? '暂无可恢复的草稿。' : '桌面版支持恢复草稿。'}</p>}
    </section> : tab === 'shortcuts' ? <section className="settings-section">
      <ShortcutSettings shortcuts={shortcuts} commands={commands} />
    </section> : <section className="settings-section">
      <div className="plugin-filters">
        <input aria-label="搜索插件" placeholder="搜索插件，如「流程图」" value={filter.query}
          onChange={event => setFilter({ ...filter, query: event.target.value })} />
        <select aria-label="插件分类" value={filter.category}
          onChange={event => setFilter({ ...filter, category: event.target.value as PluginFilter['category'] })}>
          <option value="all">全部分类</option>
          {Object.entries(COMPONENT_CATEGORIES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select aria-label="插件状态" value={filter.state}
          onChange={event => setFilter({ ...filter, state: event.target.value as PluginFilter['state'] })}>
          <option value="all">全部状态</option>
          {(['enabled', 'disabled', 'missing'] as const).map(state => <option key={state} value={state}>{EXTENSION_STATE_LABELS[state]}</option>)}
        </select>
      </div>
      {componentFeedback && <p role={componentFeedback.error ? 'alert' : 'status'} className={componentFeedback.error ? 'error' : undefined}>
        {componentFeedback.message}
      </p>}
      <Components plugins={plugins} filter={filter} operation={componentOperation}
        onChange={(id, action) => void changeOfficial(id, action)} />
      {desktop && <div className="repository-plugins">
        <div className="setting-field">
          <h3>GitHub 插件目录</h3>
          <button type="button" className="setting-action" disabled={repositoryLoading || packageBusy}
            onClick={() => void listRepositoryPlugins()}>
            {repositoryLoading ? '正在读取…' : repositoryPlugins ? '刷新目录' : '查看插件'}
          </button>
        </div>
        {repositoryError && <div className="error" role="alert">{repositoryError}</div>}
        {visibleRepositoryPlugins?.length === 0 && !repositoryLoading && !repositoryError &&
          <p role="status">没有符合筛选条件的插件。</p>}
        {visibleRepositoryPlugins?.map(item => <div className="script-plugin" key={item.id}>
          <strong>{item.name}</strong>
          <small>{item.kind === 'command' ? '命令' : '主题'} · v{item.version} · {EXTENSION_STATE_LABELS[item.state]}</small>
          <small>{item.description}</small>
          {item.available && <button type="button" className="setting-action" disabled={packageBusy || repositoryLoading}
            aria-label={`下载并${item.installed ? '更新' : '安装'} ${item.name}`} onClick={() => void installRepositoryPlugin(item)}>
            {item.installed ? '下载并更新' : '下载并安装'}
          </button>}
        </div>)}
      </div>}
      {visibleThemes.length > 0 && <h3>本地主题</h3>}
      {visibleThemes.map(item => <div className="plugin-row" key={item.manifest.id}>
        <label><input type="checkbox" checked={!plugins.preferences.disabledThemes.includes(item.manifest.id)}
          onChange={event => toggleTheme(item.manifest.id, event.target.checked)} /> {item.manifest.name}</label>
        <small>v{item.manifest.version} · 本地主题</small>
        <button type="button" onClick={() => removeTheme(item.manifest.id)}>卸载</button>
      </div>)}
      {visibleScripts.length > 0 && <h3>本地命令</h3>}
      {scripts.error && <p role="alert" className="error">{scripts.error}</p>}
      {visibleScripts.map(record => {
        const { id, name, version } = record.current.manifest;
        const permissions = permissionDescriptions(record.current);
        return <div className="script-plugin" key={id}>
          <strong>{name}</strong>
          <small>{id} · v{version} · 本地文件 · 已安装 · {record.enabled ? '已启用' : '已停用'}</small>
          <small>{permissions.length ? permissions.join('、') : '无文档权限'}</small>
          <small>点击命令可直接运行。文档变更会先列出建议供你审阅。</small>
          <div className="plugin-command-actions" aria-label={name + ' 命令'}>
            {record.current.manifest.contributes.map(commandId => {
              const label = record.current.manifest.commandLabels?.[commandId] ?? commandId;
              return <button key={commandId} type="button" className="setting-action"
                disabled={!record.enabled || packageBusy} onClick={() => onRunPluginCommand(commandId)}>
                {label}
              </button>;
            })}
          </div>
          <div className="dialog-actions">
            <button type="button" className="setting-action" disabled={packageBusy} onClick={() => void changeScript(record, 'toggle')}>
              {record.enabled ? '停用' : '启用'}
            </button>
            {record.previous && <button type="button" className="setting-action" disabled={packageBusy}
              onClick={() => void changeScript(record, 'rollback')}>回滚</button>}
            <button type="button" className="setting-action" disabled={packageBusy}
              onClick={() => void changeScript(record, 'remove')}>卸载</button>
          </div>
        </div>;
      })}
      <button type="button" className="setting-action" disabled={packageBusy} onClick={choosePlugin}>安装插件文件</button>
      <input ref={fileInput} type="file" accept=".edplugin" hidden onChange={async event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;
        if (file.size > MAX_PLUGIN_PACKAGE_BYTES) {
          setError('插件包不能超过 512 KiB。');
          return;
        }
        setPackageBusy(true);
        try { await install(await file.arrayBuffer()); }
        catch (reason) { setError(errorMessage(reason, '无法读取插件文件。')); }
        finally { setPackageBusy(false); }
      }} />
    </section>}
    {tab !== 'drafts' && (status || error) && <div className="settings-section">
      {status && <p role="status">{status}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>}
  </dialog>
  {confirmation.dialog}
  </>;
}
