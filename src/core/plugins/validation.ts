import type { PluginKind, PluginManifest, PluginPermission, ThemeContribution, ThemeTokens } from './contracts.ts';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/u;
const KINDS: readonly PluginKind[] = ['theme', 'markdown', 'render-mode', 'importer', 'exporter', 'command'];
const PERMISSIONS: readonly PluginPermission[] = ['document.read', 'document.transform', 'export.create', 'network.fetch'];
const TOKEN_KEYS: readonly (keyof ThemeTokens)[] = [
  'surface', 'text', 'mutedText', 'accent', 'border', 'codeSurface', 'fontFamily', 'readingWidth',
];

export class PluginValidationError extends Error {
  readonly code = 'manifest-invalid' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PluginValidationError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginValidationError(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new PluginValidationError(`${label} 必须是长度在 1 到 200 之间的字符串。`);
  }
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 40 || value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 200)) {
    throw new PluginValidationError(`${label} 必须是字符串数组。`);
  }
  return [...value] as string[];
}

function validateEntry(entry: string): void {
  if (entry.split('/').some(part => !/^[\w-][\w.-]*$/u.test(part))) {
    throw new PluginValidationError('entry 必须是插件包内的相对路径。');
  }
}

function checkRange(value: string): boolean {
  return VERSION_PATTERN.test(value.startsWith('^') ? value.slice(1) : value);
}

export function satisfiesPluginVersion(version: string, range: string): boolean {
  if (!range.startsWith('^')) return version === range;
  if (!VERSION_PATTERN.test(version) || !checkRange(range)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  const [baseMajor, baseMinor, basePatch] = range.slice(1).split('.').map(Number);
  if (major !== baseMajor || (major === 0 && minor !== baseMinor)) return false;
  if (major === 0 && minor === 0) return patch === basePatch;
  return minor > baseMinor || (minor === baseMinor && patch >= basePatch);
}

export function validatePluginManifest(value: unknown): PluginManifest {
  const object = record(value, 'manifest');
  if (object.schemaVersion !== 1) throw new PluginValidationError('只支持 schemaVersion 1。');
  const id = stringValue(object.id, 'id');
  if (!ID_PATTERN.test(id)) throw new PluginValidationError('id 只能包含小写字母、数字、点和连字符。');
  const name = stringValue(object.name, 'name');
  const version = stringValue(object.version, 'version');
  if (!VERSION_PATTERN.test(version)) throw new PluginValidationError('version 须使用 major.minor.patch 稳定版本号。');
  const hostApi = stringValue(object.hostApi, 'hostApi');
  if (!checkRange(hostApi)) throw new PluginValidationError('hostApi 须使用 major.minor.patch 或 ^major.minor.patch。');
  const kind = stringValue(object.kind, 'kind') as PluginKind;
  if (!KINDS.includes(kind)) throw new PluginValidationError(`不支持的插件类型：${kind}。`);
  const entry = stringValue(object.entry, 'entry');
  validateEntry(entry);
  const contributes = stringList(object.contributes, 'contributes');
  if (contributes.length === 0 || contributes.some(id => !/^(?:[a-z-]+:)?[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(id))) {
    throw new PluginValidationError('contributes 须包含有效的贡献 ID。');
  }
  if (new Set(contributes).size !== contributes.length) throw new PluginValidationError('contributes 不能包含重复 ID。');
  const commandLabels = object.commandLabels === undefined ? undefined : record(object.commandLabels, 'commandLabels');
  if (commandLabels && (kind !== 'command' || Object.keys(commandLabels).length > contributes.length ||
      Object.entries(commandLabels).some(([commandId, label]) =>
        !contributes.includes(commandId) || typeof label !== 'string' || !label.trim() || label.length > 80 ||
        /[\p{Cc}\p{Bidi_Control}]/u.test(label)))) {
    throw new PluginValidationError('commandLabels 只能为已声明的命令提供简短、安全的显示名称。');
  }
  if (!Array.isArray(object.permissions) || object.permissions.some(permission => !PERMISSIONS.includes(permission as PluginPermission))) {
    throw new PluginValidationError('permissions 包含未知权限。');
  }
  const dependenciesObject = record(object.dependencies, 'dependencies');
  const dependencies: Record<string, string> = Object.create(null);
  for (const [dependencyId, dependencyVersion] of Object.entries(dependenciesObject)) {
    if (dependencyId === id || !ID_PATTERN.test(dependencyId) || typeof dependencyVersion !== 'string' || !checkRange(dependencyVersion)) {
      throw new PluginValidationError('dependencies 必须使用有效的插件 ID 和 SemVer。');
    }
    dependencies[dependencyId] = dependencyVersion;
  }
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    hostApi,
    kind,
    entry,
    contributes,
    ...(commandLabels ? { commandLabels: { ...commandLabels } as Record<string, string> } : {}),
    permissions: [...object.permissions] as PluginPermission[],
    dependencies,
  };
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u;
const LENGTH = /^(\d{1,4}(?:\.\d{1,2})?)(px|rem|em|ch|vw|%)$/u;
const MAX_LENGTH: Readonly<Record<string, number>> = { px: 2_000, rem: 120, em: 120, ch: 160, vw: 100, '%': 100 };
const FONT_FAMILY = /^[\p{L}\p{N} ,'"-]{1,120}$/u;

function tokenValue(key: keyof ThemeTokens, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120) {
    throw new PluginValidationError(`主题令牌 ${key} 必须是短字符串。`);
  }
  if (key === 'fontFamily' && !FONT_FAMILY.test(value)) throw new PluginValidationError('fontFamily 含有不允许的字符。');
  if (key === 'readingWidth') {
    const match = LENGTH.exec(value);
    if (!match || Number(match[1]) <= 0 || Number(match[1]) > MAX_LENGTH[match[2]]) {
      throw new PluginValidationError('readingWidth 必须是受限 CSS 长度。');
    }
  }
  if (key !== 'fontFamily' && key !== 'readingWidth' && !HEX_COLOR.test(value)) {
    throw new PluginValidationError(`主题令牌 ${key} 须为 #RRGGBB 或 #RRGGBBAA 颜色。`);
  }
  return value;
}

export function validateThemeContribution(value: unknown): ThemeContribution {
  const object = record(value, 'theme');
  const id = stringValue(object.id, 'theme.id');
  if (!ID_PATTERN.test(id)) throw new PluginValidationError('theme.id 无效。');
  const name = stringValue(object.name, 'theme.name');
  const tokenObject = record(object.tokens, 'theme.tokens');
  const unknown = Object.keys(tokenObject).filter(key => !TOKEN_KEYS.includes(key as keyof ThemeTokens));
  if (unknown.length > 0) throw new PluginValidationError(`主题包含未知令牌：${unknown.join('、')}。`);
  const tokens = {} as Record<keyof ThemeTokens, string>;
  for (const key of TOKEN_KEYS) tokens[key] = tokenValue(key, tokenObject[key]);
  return { id, name, tokens };
}
