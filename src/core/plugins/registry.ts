import type {
  Disposable, PluginContributionMap, PluginDiagnostic, PluginKind, PluginManifest, PluginModule, PluginRegistryLike,
} from './contracts.ts';
import { PLUGIN_API_VERSION } from './contracts.ts';
import { satisfiesPluginVersion, validatePluginManifest } from './validation.ts';

interface RegisteredContribution {
  readonly pluginId: string;
  readonly contribution: unknown;
}

export class PluginRegistry implements PluginRegistryLike {
  private readonly contributions = new Map<PluginKind, Map<string, RegisteredContribution>>();
  private readonly modules = new Map<string, PluginManifest>();
  private readonly diagnostics: PluginDiagnostic[] = [];
  private readonly coreIds = new Set<string>();
  private readonly activations = new Map<string, readonly Disposable[]>();

  constructor(coreContributions: Partial<Record<PluginKind, readonly string[]>> = {}) {
    for (const [kind, ids] of Object.entries(coreContributions)) {
      for (const id of ids ?? []) this.coreIds.add(`${kind}:${id}`);
    }
  }

  register<K extends PluginKind>(kind: K, contribution: PluginContributionMap[K], pluginId = 'core'): Disposable {
    const id = contribution.id;
    if (!id) throw new Error('贡献必须包含 id。');
    const key = `${kind}:${id}`;
    if (pluginId !== 'core' && this.coreIds.has(key)) throw new Error(`贡献 ID ${key} 已被核心占用。`);
    const bucket = this.contributions.get(kind) ?? new Map<string, RegisteredContribution>();
    if (bucket.has(id)) throw new Error(`贡献 ID ${key} 已注册。`);
    const registered: RegisteredContribution = { pluginId, contribution };
    bucket.set(id, registered);
    this.contributions.set(kind, bucket);
    return { dispose: () => { if (bucket.get(id) === registered) bucket.delete(id); } };
  }

  activate(module: PluginModule): boolean {
    let manifest: PluginManifest;
    try {
      manifest = validatePluginManifest(module.manifest);
    } catch (error) {
      const pluginId = typeof module.manifest?.id === 'string' ? module.manifest.id : '<unknown>';
      this.diagnostics.push({ pluginId, code: 'manifest-invalid', message: error instanceof Error ? error.message : '插件清单无效。' });
      return false;
    }
    if (!satisfiesPluginVersion(PLUGIN_API_VERSION, manifest.hostApi)) {
      this.diagnostics.push({ pluginId: manifest.id, code: 'host-api-incompatible', message: '插件要求的 API 版本与当前应用不兼容。' });
      return false;
    }
    if (this.modules.has(manifest.id)) {
      this.diagnostics.push({ pluginId: manifest.id, code: 'contribution-conflict', message: '插件 ID 已经激活。' });
      return false;
    }
    for (const [dependencyId, dependencyRange] of Object.entries(manifest.dependencies)) {
      const dependency = this.modules.get(dependencyId);
      if (!dependency) {
        this.diagnostics.push({ pluginId: manifest.id, code: 'dependency-missing', message: `缺少依赖插件 ${dependencyId}。` });
        return false;
      }
      if (!satisfiesPluginVersion(dependency.version, dependencyRange)) {
        this.diagnostics.push({ pluginId: manifest.id, code: 'dependency-incompatible', message: `依赖插件 ${dependencyId} 版本不兼容。` });
        return false;
      }
    }
    const disposables: Disposable[] = [];
    let accepting = true;
    const scopedRegistry: PluginRegistryLike = {
      register: (kind, contribution) => {
        if (!accepting) throw new Error('贡献只能在插件激活期间注册。');
        if (!manifest.contributes.includes(contribution.id) && !manifest.contributes.includes(kind + ':' + contribution.id)) {
          throw new Error('贡献 ID 未在插件清单中声明。');
        }
        const disposable = this.register(kind, contribution, manifest.id);
        disposables.push(disposable);
        return disposable;
      },
    };
    try {
      const cleanup = module.activate(scopedRegistry);
      if (typeof cleanup === 'function') disposables.push({ dispose: cleanup });
      else if (cleanup) disposables.push(cleanup);
      this.modules.set(manifest.id, manifest);
      this.activations.set(manifest.id, disposables);
      return true;
    } catch (error) {
      this.dispose(manifest.id, disposables);
      this.diagnostics.push({ pluginId: manifest.id, code: 'activation-failed', message: error instanceof Error ? error.message : '插件激活失败。' });
      return false;
    } finally {
      accepting = false;
    }
  }

  deactivate(pluginId: string): boolean {
    if (!this.modules.delete(pluginId)) return false;
    for (const [dependentId, dependent] of this.modules) {
      if (Object.hasOwn(dependent.dependencies, pluginId)) this.deactivate(dependentId);
    }
    const disposables = this.activations.get(pluginId) ?? [];
    this.activations.delete(pluginId);
    this.dispose(pluginId, disposables);
    return true;
  }

  private dispose(pluginId: string, disposables: readonly Disposable[]): void {
    for (const disposable of [...disposables].reverse()) {
      try {
        disposable.dispose();
      } catch {
        this.diagnostics.push({ pluginId, code: 'cleanup-failed', message: '插件清理失败，已移除注册贡献。' });
      }
    }
  }

  list<K extends PluginKind>(kind: K): readonly PluginContributionMap[K][] {
    return [...(this.contributions.get(kind)?.values() ?? [])].sort((a, b) => a.pluginId.localeCompare(b.pluginId))
      .map(entry => entry.contribution as PluginContributionMap[K]);
  }

  diagnosticsSnapshot(): readonly PluginDiagnostic[] {
    return [...this.diagnostics];
  }

  manifestsSnapshot(): readonly PluginManifest[] {
    return [...this.modules.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
