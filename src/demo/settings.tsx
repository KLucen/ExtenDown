import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PluginRegistry, builtinExporterModules, builtinExtraLanguagesModule, builtinMathModule, builtinMermaidModule,
  createThemeModule, MAX_THEME_PACKAGE_BYTES, readThemePlugin, themeStyle, validateThemePlugin,
} from '../core/plugins';
import type { PluginModule, ThemeContribution } from '../core/plugins';
import { loadAdditionalLanguages, loadMathRenderer } from '../core/plugins/reading-extensions';
import type { ExportFormat } from '../core/export';
import { errorMessage, type RecoveryDraft } from './document-session';

const STORE_KEY = 'extendown.extensions.v1';
const FORMATS = ['html', 'pdf', 'png', 'jpg'] as const;
const COMPONENTS = ['html', 'math', 'mermaid', 'focus', 'pdf', 'images', 'languages', 'theme'] as const;
type Component = typeof COMPONENTS[number];
const FULL_COMPONENTS = new Set<Component>(COMPONENTS);
const NO_COMPONENTS = new Set<Component>();
const OFFICIAL_THEME_ID = 'org.extendown.theme.midnight';
let componentRequest: Promise<ReadonlySet<Component>> | undefined;

function queryComponents(): Promise<ReadonlySet<Component>> {
  return componentRequest ??= invoke<string[] | null>('installed_components').then(
    installed => installed === null ? FULL_COMPONENTS : new Set(COMPONENTS.filter(choice => installed.includes(choice))),
  );
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
type ThemePackage = Awaited<ReturnType<typeof readThemePlugin>>;

interface Preferences {
  configured: boolean;
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
  configured: false, math: true, mermaid: true, languages: true, presentation: true,
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
      configured: stored.configured === true,
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
  const [installed, setInstalled] = useState<ReadonlySet<Component> | null>(() => isTauri() ? null : FULL_COMPONENTS);
  const [loaded, setLoaded] = useState<Partial<Record<LazyComponent, PluginModule>>>({});
  const [extensionError, setExtensionError] = useState('');
  const components = installed ?? NO_COMPONENTS;
  const officialThemeEnabled = !preferences.disabledThemes.includes(OFFICIAL_THEME_ID);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void queryComponents().then(result => { if (active) setInstalled(result); }, () => {
      if (active) {
        setInstalled(NO_COMPONENTS);
        setExtensionError('无法读取桌面版已安装组件。');
      }
    });
    return () => { active = false; };
  }, []);

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
    markdown, formats, focusAvailable, components, extensionError, componentsReady: installed !== null,
    install,
  };
}

function componentForFormat(format: ExportFormat): Component {
  return format === 'png' || format === 'jpg' ? 'images' : format;
}

type Extensions = ReturnType<typeof useExtensions>;

function Components({ plugins, onDone }: { plugins: Extensions; onDone?: () => void }) {
  const prefs = plugins.preferences;
  return <fieldset className="component-options">
    <legend>可选扩展</legend>
    <label><input type="checkbox" checked={plugins.components.has('math') && prefs.math} disabled={!plugins.components.has('math')} onChange={event => {
      const checked = event.target.checked;
      plugins.update(state => ({ ...state, math: checked }));
    }} /> 数学公式</label>
    <label><input type="checkbox" checked={plugins.components.has('mermaid') && prefs.mermaid} disabled={!plugins.components.has('mermaid')} onChange={event => {
      const checked = event.target.checked;
      plugins.update(state => ({ ...state, mermaid: checked }));
    }} /> Mermaid 图表</label>
    <label><input type="checkbox" checked={plugins.components.has('languages') && prefs.languages} disabled={!plugins.components.has('languages')} onChange={event => {
      const checked = event.target.checked;
      plugins.update(state => ({ ...state, languages: checked }));
    }} /> 扩展代码语言</label>
    <label><input type="checkbox" checked={plugins.components.has('focus') && prefs.presentation} disabled={!plugins.components.has('focus')} onChange={event => {
      const checked = event.target.checked;
      plugins.update(state => ({ ...state, presentation: checked }));
    }} /> 专注视图</label>
    {FORMATS.map(format => <label key={format}><input type="checkbox" checked={plugins.components.has(componentForFormat(format)) && prefs.formats.includes(format)}
      disabled={!plugins.components.has(componentForFormat(format))} onChange={event => {
      const checked = event.target.checked;
      plugins.update(state => ({ ...state, formats: FORMATS.filter(item => item === format ? checked : state.formats.includes(item)) }));
    }} /> {format.toUpperCase()} 导出</label>)}
    {plugins.componentsReady && COMPONENTS.some(component => !plugins.components.has(component)) &&
      <small>可通过 Windows 安装器添加缺少的官方组件。</small>}
    {plugins.extensionError && <p className="error" role="alert">{plugins.extensionError}</p>}
    {onDone && <button type="button" className="setting-action" disabled={!plugins.componentsReady} onClick={onDone}>开始使用</button>}
  </fieldset>;
}

export function FirstRun({ plugins, onClose }: { plugins: Extensions; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  function finish() {
    plugins.update(state => ({ ...state, configured: true }));
    dialog.current?.close();
  }
  return <dialog className="settings-modal" ref={dialog} aria-labelledby="components-title" onClose={onClose}
    onCancel={event => { event.preventDefault(); finish(); }}>
    <div className="modal-head"><h2 id="components-title">选择扩展</h2></div>
    <div className="settings-section">
      <p>可在设置中调整这些选项。</p>
      <Components plugins={plugins} onDone={finish} />
    </div>
  </dialog>;
}

export function Settings({ desktop, plugins, drafts, onDiscardDraft, onClose, launchDefaults }: {
  desktop: boolean;
  plugins: Extensions;
  drafts: RecoveryDraft[];
  onDiscardDraft: (id: string) => Promise<void>;
  onClose: () => void;
  launchDefaults: () => Promise<{ supported: boolean; requested: boolean; message: string }>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'general' | 'plugins'>('general');
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function install(buffer: ArrayBuffer) {
    setStatus('');
    setError('');
    try {
      const item = await readThemePlugin(buffer);
      plugins.install(item);
      setStatus('已安装 ' + item.manifest.name);
    } catch (reason) {
      setError(errorMessage(reason, '无法安装主题包。'));
    }
  }

  async function chooseTheme() {
    if (!desktop) {
      fileInput.current?.click();
      return;
    }
    try {
      const bytes = await invoke<number[] | null>('open_theme_package');
      if (bytes) await install(new Uint8Array(bytes).buffer);
    } catch (reason) {
      setError(errorMessage(reason, '无法打开主题插件文件。'));
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

  const selectedTheme = [DARK_THEME, ...plugins.themes].some(theme => theme.id === plugins.preferences.theme)
    ? plugins.preferences.theme : 'core.light';
  return <dialog className="settings-modal" ref={dialog} aria-labelledby="settings-title" onClose={onClose}>
    <div className="modal-head"><h2 id="settings-title">设置</h2>
      <button type="button" aria-label="关闭设置" onClick={() => dialog.current?.close()}>×</button>
    </div>
    <div className="settings-tabs" aria-label="设置类别">
      <button type="button" aria-pressed={tab === 'general'} onClick={() => setTab('general')}>常规</button>
      <button type="button" aria-pressed={tab === 'plugins'} onClick={() => setTab('plugins')}>插件</button>
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
      {drafts.length > 0 && <section className="settings-section">
        <h3>恢复草稿</h3>
        {drafts.map(draft => <div className="plugin-row" key={draft.id}>
          <span title={draft.path ?? draft.name}>{draft.name}</span>
          <button type="button" onClick={() => {
            if (window.confirm('移除这份恢复草稿？')) void onDiscardDraft(draft.id);
          }}>移除</button>
        </div>)}
      </section>}
    </> : <section className="settings-section">
      <Components plugins={plugins} />
      <h3>主题包</h3>
      {plugins.components.has('theme') && <div className="plugin-row">
        <label><input type="checkbox" checked={!plugins.preferences.disabledThemes.includes(OFFICIAL_THEME_ID)}
          onChange={event => toggleTheme(OFFICIAL_THEME_ID, event.target.checked)} /> Midnight</label>
        <small>官方示例</small>
      </div>}
      {plugins.preferences.packages.map(item => <div className="plugin-row" key={item.manifest.id}>
        <label><input type="checkbox" checked={!plugins.preferences.disabledThemes.includes(item.manifest.id)}
          onChange={event => toggleTheme(item.manifest.id, event.target.checked)} /> {item.manifest.name}</label>
        <small>v{item.manifest.version} · 本地主题</small>
        <button type="button" onClick={() => removeTheme(item.manifest.id)}>卸载</button>
      </div>)}
      <button type="button" className="setting-action" onClick={chooseTheme}>安装插件文件</button>
      <input ref={fileInput} type="file" accept=".edplugin" hidden onChange={async event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) return;
        if (file.size > MAX_THEME_PACKAGE_BYTES) {
          setError('主题包不能超过 512 KiB。');
          return;
        }
        try { await install(await file.arrayBuffer()); }
        catch (reason) { setError(errorMessage(reason, '无法读取主题文件。')); }
      }} />
    </section>}
    {(status || error) && <div className="settings-section">
      {status && <p role="status">{status}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>}
  </dialog>;
}
