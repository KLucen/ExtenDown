export interface EditorSelection {
  readonly start: number;
  readonly end: number;
  readonly direction: 'forward' | 'backward' | 'none';
}

export interface SourcePatch {
  readonly start: number;
  readonly end: number;
  readonly expected: string;
  readonly insert: string;
  readonly selection?: EditorSelection;
}

export interface CommandDescription {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly scope: 'app' | 'source';
  readonly aliases?: string;
  readonly defaultShortcut?: string | { readonly mac: string; readonly other: string };
}

export interface EditorCommand extends CommandDescription {
  readonly source?: string;
  readonly enabled?: boolean;
  readonly run: () => void;
}

export type ShortcutOverrides = Readonly<Record<string, string | null>>;

function command<Id extends string>(id: Id, label: string, category: string, aliases: string,
  defaultShortcut?: CommandDescription['defaultShortcut'], scope: CommandDescription['scope'] = 'app') {
  return { id, label, category, aliases, defaultShortcut, scope };
}

const file = '文件', edit = '编辑', view = '视图', app = '应用';
const format = '格式', paragraph = '段落', insert = '插入';

export const EDITOR_COMMANDS = {
  'file.new': command('file.new', '新建文档', file, 'new', 'Mod+N'),
  'file.open': command('file.open', '打开文件', file, 'open 导入', 'Mod+O'),
  'file.save': command('file.save', '保存', file, 'save', 'Mod+S'),
  'file.save-as': command('file.save-as', '另存为', file, 'save as', 'Mod+Shift+S'),
  'file.new-window': command('file.new-window', '新建窗口', file, 'new window'),
  'file.reload': command('file.reload', '从磁盘重新载入', file, 'reload refresh 刷新'),
  'file.export': command('file.export', '导出', file, 'export html pdf png jpg'),
  'edit.find': command('edit.find', '查找', edit, 'find search 搜索', 'Mod+F'),
  'edit.replace': command('edit.replace', '查找替换', edit, 'replace 搜索', { mac: 'Mod+Alt+F', other: 'Mod+H' }),
  'edit.undo': command('edit.undo', '撤销', edit, 'undo', 'Mod+Z'),
  'edit.redo': command('edit.redo', '重做', edit, 'redo', { mac: 'Mod+Shift+Z', other: 'Mod+Y' }),
  'edit.cut': command('edit.cut', '剪切', edit, 'cut', undefined, 'source'),
  'edit.copy': command('edit.copy', '复制', edit, 'copy', undefined, 'source'),
  'edit.paste': command('edit.paste', '粘贴为纯文本', edit, 'paste plain text', undefined, 'source'),
  'view.source': command('view.source', '显示源码', view, 'source'),
  'view.split': command('view.split', '显示并排视图', view, 'split'),
  'view.preview': command('view.preview', '显示预览', view, 'preview'),
  'view.outline': command('view.outline', '切换文档目录', view, 'outline 大纲'),
  'view.focus': command('view.focus', '切换专注视图', view, 'focus'),
  'view.workspace': command('view.workspace', '切换工作区面板', view, 'workspace 文件树'),
  'app.commands': command('app.commands', '打开命令面板', app, 'command palette', 'Mod+Shift+P'),
  'app.settings': command('app.settings', '打开设置', app, 'settings preferences'),
  'app.shortcuts': command('app.shortcuts', '编辑快捷键', app, 'keymap hotkey shortcut'),
  'app.script-history': command('app.script-history', '查看插件命令记录', app, 'script history'),
  'format.bold': command('format.bold', '粗体', format, 'bold 加粗', 'Mod+B', 'source'),
  'format.italic': command('format.italic', '斜体', format, 'italic', 'Mod+I', 'source'),
  'format.link': command('format.link', '插入链接', format, 'link 超链接', 'Mod+K', 'source'),
  'format.strike': command('format.strike', '删除线', format, 'strikethrough', undefined, 'source'),
  'format.inline-code': command('format.inline-code', '行内代码', format, 'inline code', undefined, 'source'),
  'paragraph.heading': command('paragraph.heading', '二级标题', paragraph, 'heading header', undefined, 'source'),
  'paragraph.quote': command('paragraph.quote', '引用', paragraph, 'quote blockquote', undefined, 'source'),
  'paragraph.bullet': command('paragraph.bullet', '无序列表', paragraph, 'bullet list', undefined, 'source'),
  'paragraph.task': command('paragraph.task', '任务列表', paragraph, 'task checkbox todo', undefined, 'source'),
  'insert.code': command('insert.code', '插入代码块', insert, 'fenced code', undefined, 'source'),
  'insert.table': command('insert.table', '插入表格', insert, 'table', undefined, 'source'),
  'insert.math': command('insert.math', '插入数学公式', insert, 'math latex', undefined, 'source'),
  'insert.mermaid': command('insert.mermaid', '插入 Mermaid 图表', insert, 'mermaid diagram flowchart 画流程图 流程图', undefined, 'source'),
} as const;

export type EditorCommandId = keyof typeof EDITOR_COMMANDS;

export function matchesCommand(command: CommandDescription & { readonly source?: string }, query: string): boolean {
  const text = `${command.label} ${command.category} ${command.aliases ?? ''} ${command.id} ${command.source ?? '内置'}`.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/u).every(part => text.includes(part));
}

export function commandShortcut(command: CommandDescription, overrides: ShortcutOverrides, mac: boolean): string | null {
  if (Object.hasOwn(overrides, command.id)) return overrides[command.id];
  const shortcut = command.defaultShortcut;
  return (typeof shortcut === 'string' ? shortcut : shortcut?.[mac ? 'mac' : 'other']) ?? null;
}

const KEY_PATTERN = /^(?:(?:Mod|Ctrl|Meta)\+)?(?:Alt\+)?(?:Shift\+)?(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/u;
const RESERVED = new Set(['Mod+A', 'Mod+C', 'Mod+X', 'Mod+V', 'Mod+Shift+V', 'Mod+W', 'Mod+Q', 'Mod+T',
  'Mod+R', 'Mod+L', 'Mod+P', 'Mod+Tab', 'Shift+F10', 'F5', 'F11', 'F12', 'Alt+F4', 'Mod+Shift+Z']);

export function validShortcut(shortcut: string): boolean {
  return KEY_PATTERN.test(shortcut) && (/^(?:Mod|Ctrl|Meta|Alt)\+/u.test(shortcut) || /F\d+$/u.test(shortcut));
}

export function shortcutForKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'getModifierState'>, mac: boolean): string | null {
  if ((event.ctrlKey && event.metaKey) || event.getModifierState('AltGraph')) return null;
  let key = event.key.toUpperCase();
  if (event.altKey && !/^[A-Z0-9]$/u.test(key)) key = event.code.match(/^(?:Key|Digit)([A-Z0-9])$/u)?.[1] ?? key;
  const modifier = event.ctrlKey ? (mac ? 'Ctrl+' : 'Mod+') : event.metaKey ? (mac ? 'Mod+' : 'Meta+') : '';
  const shortcut = modifier + (event.altKey ? 'Alt+' : '') + (event.shiftKey ? 'Shift+' : '') + key;
  return validShortcut(shortcut) ? shortcut : null;
}

export function shortcutLabel(command: CommandDescription, overrides: ShortcutOverrides, mac: boolean): string {
  return commandShortcut(command, overrides, mac)?.replace('Mod+', mac ? 'Cmd+' : 'Ctrl+').replace('Alt+', mac ? 'Option+' : 'Alt+') ?? '';
}

export function shortcutConflict(candidate: string, id: string, commands: readonly CommandDescription[], overrides: ShortcutOverrides, mac: boolean): string | null {
  if (!validShortcut(candidate)) return '请使用修饰键搭配字母或数字，或使用功能键。';
  if (candidate === commandShortcut(EDITOR_COMMANDS['edit.redo'], {}, mac) && id === 'edit.redo') return null;
  if (RESERVED.has(candidate) || candidate === 'Mod+Y') return '此按键由系统或源码编辑器使用。';
  const conflicting = commands.find(command => command.id !== id && commandShortcut(command, overrides, mac) === candidate);
  return conflicting ? `此按键已用于「${conflicting.label}」。` : null;
}

export function isSourceCommand(id: EditorCommandId): boolean {
  return EDITOR_COMMANDS[id].scope === 'source';
}

function select(start: number, end: number, direction: EditorSelection['direction']): EditorSelection {
  return { start, end, direction: start === end ? 'none' : direction === 'backward' ? 'backward' : 'forward' };
}

export function buildSourceCommandPatch(id: EditorCommandId, source: string, selection: EditorSelection): SourcePatch | null {
  const { start, end, direction } = selection;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.length) return null;
  const text = source.slice(start, end);
  function wrap(before: string, after = before, canUnwrap = true): SourcePatch {
    if (canUnwrap && text && start >= before.length && source.slice(start - before.length, start) === before && source.slice(end, end + after.length) === after) {
      const from = start - before.length;
      return { start: from, end: end + after.length, expected: before + text + after, insert: text,
        selection: select(from, from + text.length, direction) };
    }
    const visible = text.trim();
    const leading = visible ? text.length - text.trimStart().length : text.length;
    const offset = start + leading + before.length;
    return { start, end, expected: text, insert: text.slice(0, leading) + before + visible + after + text.slice(leading + visible.length),
      selection: select(offset, offset + visible.length, direction) };
  }
  function lines(prefix: string, marker: RegExp): SourcePatch {
    const from = start === 0 ? 0 : source.lastIndexOf('\n', start - 1) + 1;
    const nextLine = source.indexOf('\n', text.endsWith('\n') ? end - 1 : end);
    const to = nextLine < 0 ? source.length : nextLine;
    const expected = source.slice(from, to);
    const selected = expected.split('\n');
    const remove = selected.every(line => !line.trim() || line.startsWith(prefix)) && selected.some(line => line.startsWith(prefix));
    const replacement = selected.map(line => {
      if (!line.trim() && selected.length > 1) return { line, delta: 0 };
      const existing = line.match(marker)?.[0] ?? '';
      const linePrefix = remove ? '' : prefix;
      return { line: linePrefix + line.slice(existing.length), delta: linePrefix.length - existing.length };
    });
    const insert = replacement.map(value => value.line).join('\n');
    const offset = Math.max(from, start + replacement[0].delta);
    const last = end + insert.length - expected.length;
    return { start: from, end: to, expected, insert, selection: select(offset, Math.max(offset, last), direction) };
  }
  function block(template: string, anchor: number, length = 0, preserve = false): SourcePatch {
    const from = preserve ? end : start;
    const before = source.slice(Math.max(0, from - 2), from);
    const after = source.slice(end, end + 2);
    const prefix = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const suffix = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const offset = from + prefix.length + anchor;
    return { start: from, end, expected: preserve ? '' : text, insert: prefix + template + suffix, selection: select(offset, offset + length, direction) };
  }
  switch (id) {
    case 'format.bold': return wrap('**');
    case 'format.italic': {
      const before = source.slice(0, start).match(/\*+$/u)?.[0].length ?? 0;
      const after = source.slice(end).match(/^\*+/u)?.[0].length ?? 0;
      return wrap('*', '*', before % 2 === 1 && after % 2 === 1);
    }
    case 'format.strike': return wrap('~~');
    case 'format.inline-code': {
      let longest = 0;
      for (const match of text.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
      const fence = '`'.repeat(longest + 1);
      const padded = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && !!text.trim());
      const delimiter = padded ? ' ' : '';
      const offset = start + fence.length + delimiter.length;
      return { start, end, expected: text, insert: fence + delimiter + text + delimiter + fence,
        selection: select(offset, offset + text.length, direction) };
    }
    case 'format.link': {
      const label = text ? text.replace(/(?<!\\)[[\]]/gu, '\\$&') : '链接文字';
      const target = 'https://example.com';
      const offset = start + label.length + 3;
      return { start, end, expected: text, insert: `[${label}](${target})`, selection: select(offset, offset + target.length, direction) };
    }
    case 'paragraph.heading': return lines('## ', /^#{1,6}[ \t]+/u);
    case 'paragraph.quote': return lines('> ', /^> ?/u);
    case 'paragraph.bullet': return lines('- ', /^[-+*][ \t]+/u);
    case 'paragraph.task': return lines('- [ ] ', /^(?:[-+*][ \t]+(?:\[[ xX]\][ \t]+)?)/u);
    case 'insert.table': return block('| 列一 | 列二 |\n| --- | --- |\n|  |  |', 2, 2, true);
    case 'insert.code': {
      let longest = 2;
      for (const match of text.matchAll(/^ {0,3}(`{3,})/gmu)) longest = Math.max(longest, match[1].length);
      const fence = '`'.repeat(longest + 1);
      return block(`${fence}\n${text}\n${fence}`, fence.length + 1, text.length);
    }
    case 'insert.math': return text && !text.includes('\n') ? wrap('$') : block(`$$\n${text || 'x^2'}\n$$`, 3, text.length || 3);
    case 'insert.mermaid': return block('```mermaid\nflowchart LR\n  A --> B\n```', 11, 22, true);
    default: return null;
  }
}
