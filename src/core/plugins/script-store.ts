import { validateScriptPlugin, type ScriptPlugin } from './script-package.ts';

const DATABASE = 'extendown-code-plugins';
const COLLECTION = 'plugins';
const MAX_INSTALLED = 40;

export interface ScriptPluginRecord {
  readonly current: ScriptPlugin;
  readonly previous: ScriptPlugin | null;
  readonly enabled: boolean;
  readonly generation: string;
}

let databaseRequest: Promise<IDBDatabase> | undefined;
let channel: BroadcastChannel | undefined;
const listeners = new Set<() => void>();

function openDatabase(): Promise<IDBDatabase> {
  databaseRequest ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(COLLECTION);
    request.onsuccess = () => {
      const db = request.result;
      const close = () => {
        databaseRequest = undefined;
        db.close();
      };
      db.onversionchange = close;
      db.onclose = close;
      resolve(db);
    };
    request.onerror = () => reject(new Error('无法打开命令插件存储。'));
  }).catch(error => {
    databaseRequest = undefined;
    throw error;
  });
  return databaseRequest;
}

function pluginChannel() {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(DATABASE);
    channel.onmessage = () => listeners.forEach(listener => listener());
  }
  return channel;
}

export function subscribeToScriptPlugins(listener: () => void): () => void {
  listeners.add(listener);
  pluginChannel();
  return () => listeners.delete(listener);
}

function publishChange() {
  pluginChannel()?.postMessage('changed');
  listeners.forEach(listener => listener());
}

function storedRecord(value: unknown): ScriptPluginRecord {
  if (!value || typeof value !== 'object' || !('current' in value) || !('previous' in value) ||
      !('enabled' in value) || typeof value.enabled !== 'boolean' ||
      !('generation' in value) || typeof value.generation !== 'string' || !value.generation) {
    throw new Error('命令插件记录无法读取。');
  }
  const current = validateScriptPlugin(value.current);
  const previous = value.previous === null ? null : validateScriptPlugin(value.previous);
  if (previous && previous.manifest.id !== current.manifest.id) {
    throw new Error('命令插件历史版本与当前插件 ID 不匹配。');
  }
  return { current, previous, enabled: value.enabled, generation: value.generation };
}

function getRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法读取命令插件。'));
  });
}

export async function listScriptPlugins(): Promise<ScriptPluginRecord[]> {
  const database = await openDatabase();
  const collection = database.transaction(COLLECTION, 'readonly').objectStore(COLLECTION);
  const rows: unknown[] = await getRequest(collection.getAll());
  return rows.map(storedRecord).sort((a, b) => a.current.manifest.id.localeCompare(b.current.manifest.id));
}

export async function getScriptPlugin(id: string): Promise<ScriptPluginRecord | null> {
  const database = await openDatabase();
  const collection = database.transaction(COLLECTION, 'readonly').objectStore(COLLECTION);
  const value: unknown = await getRequest(collection.get(id));
  if (value === undefined) return null;
  const installed = storedRecord(value);
  if (installed.current.manifest.id !== id) throw new Error('命令插件记录的 ID 不匹配。');
  return installed;
}

function state(current: ScriptPlugin, previous: ScriptPlugin | null, enabled: boolean): ScriptPluginRecord {
  const generation = crypto.getRandomValues(new Uint32Array(4)).join('-');
  return { current, previous, enabled, generation };
}

function checkVersion(
  existing: ScriptPluginRecord | undefined,
  expectedVersion: string | null,
  expectedGeneration: string | undefined,
) {
  if ((existing?.current.manifest.version ?? null) !== expectedVersion ||
      (expectedGeneration !== undefined && existing?.generation !== expectedGeneration)) {
    throw new Error('插件状态已在其他窗口更新，请刷新后重试。');
  }
}

function assertUniqueCommands(candidate: ScriptPlugin, records: readonly ScriptPluginRecord[]) {
  const commands = new Set(candidate.manifest.contributes);
  if (records.some(record => record.current.manifest.id !== candidate.manifest.id &&
      record.current.manifest.contributes.some(id => commands.has(id)))) {
    throw new Error('命令 ID 已被其他插件使用。');
  }
}

function compareVersions(left: string, right: string): number {
  const parts = left.split('.').map(Number);
  const compared = right.split('.').map(Number);
  return parts[0] - compared[0] || parts[1] - compared[1] || parts[2] - compared[2];
}

async function changeRecord(
  id: string,
  expectedVersion: string | null,
  expectedGeneration: string | undefined,
  change: (existing: ScriptPluginRecord | undefined, records: readonly ScriptPluginRecord[]) => ScriptPluginRecord | null,
): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(COLLECTION, 'readwrite');
    const collection = transaction.objectStore(COLLECTION);
    let failure: unknown;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? new Error('无法更新命令插件。'));
    const request = collection.getAll();
    request.onsuccess = () => {
      try {
        const records = (request.result as unknown[]).map(storedRecord);
        const existing = records.find(record => record.current.manifest.id === id);
        checkVersion(existing, expectedVersion, expectedGeneration);
        const next = change(existing, records);
        if (next) collection.put(next, id);
        else collection.delete(id);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
  });
  publishChange();
}

export async function installScriptPlugin(
  plugin: ScriptPlugin,
  expectedVersion: string | null,
  expectedGeneration?: string,
): Promise<void> {
  const candidate = validateScriptPlugin(plugin);
  await changeRecord(candidate.manifest.id, expectedVersion, expectedGeneration, (existing, records) => {
    if (!existing && records.length >= MAX_INSTALLED) throw new Error('最多可安装 40 个命令插件。');
    if (existing && compareVersions(candidate.manifest.version, existing.current.manifest.version) <= 0) {
      throw new Error('请选择较新版本的插件包，或使用回滚。');
    }
    assertUniqueCommands(candidate, records);
    return state(candidate, existing?.current ?? null, false);
  });
}

export function setScriptPluginEnabled(
  id: string,
  version: string,
  enabled: boolean,
  expectedGeneration?: string,
): Promise<void> {
  return changeRecord(id, version, expectedGeneration, existing => {
    if (!existing) throw new Error('命令插件尚未安装。');
    return state(existing.current, existing.previous, enabled);
  });
}

export function rollbackScriptPlugin(
  id: string,
  version: string,
  previousVersion: string,
  expectedGeneration?: string,
): Promise<void> {
  return changeRecord(id, version, expectedGeneration, (existing, records) => {
    if (!existing?.previous || existing.previous.manifest.version !== previousVersion) {
      throw new Error('没有可用的上一个插件版本。');
    }
    assertUniqueCommands(existing.previous, records);
    return state(existing.previous, null, false);
  });
}

export function uninstallScriptPlugin(id: string, version: string, expectedGeneration?: string): Promise<void> {
  return changeRecord(id, version, expectedGeneration, () => null);
}
