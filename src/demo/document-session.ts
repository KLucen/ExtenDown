import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { editorToMarkdownText, markdownToEditorText } from '../core/editor-text';
import { decodeMarkdownBytes, encodeMarkdownBytes } from '../core/markdown-source';
import type { MarkdownSourceFormat } from '../core/markdown-source';
import type { SourceSelection, SourceSurfaceHandle } from '../renderer/source-surface';

interface NativeDocument {
  documentId: string;
  name: string;
  path: string | null;
  source: string;
  format: MarkdownSourceFormat;
  revision: number;
  recovered?: boolean;
  formatChanged?: boolean;
  baseSource?: string | null;
}

export interface DocumentView extends Omit<NativeDocument, 'documentId'> {
  key: number;
  documentId?: string;
  initialSource: string;
}

export interface RecentDocument { id: string; name: string; path: string }
export interface RecoveryDraft { id: string; name: string; path: string | null }
export interface WorkspaceLocation { documentId: string; line: number }
export type WorkspaceDiskStatus = 'unchanged' | 'changed' | 'missing';
export type UniformLineEnding = 'lf' | 'crlf';

const EXAMPLE = [
  '# 写下你的想法', '', '在源码区编辑，预览会随草稿更新。', '',
  '- [x] 支持 GFM 任务列表', '- [ ] 开始写作', '',
  '| 视图 | 用途 |', '| --- | --- |', '| 源码 | 编辑 |', '| 预览 | 阅读 |', '',
  '~~~javascript', 'const editor = "ExtenDown";', '~~~', '',
].join('\n');
const START_SELECTION: SourceSelection = { start: 0, end: 0, direction: 'none' };
const ERRORS: Record<string, string> = {
  'external-change': '文件已在其他应用中修改。可重新载入磁盘版本，或另存当前草稿。',
  'revision-conflict': '当前修订已变更，请重新载入文档。',
  'path-already-open': '目标文件已在另一个窗口打开。',
  'invalid-utf8': '文档需要使用 UTF-8 编码。',
  'file-too-large': '文件超过支持的大小。',
  'mixed-line-endings-read-only': '混合换行文档为只读。',
  'invalid-line-ending': '请选择 LF 或 CRLF 换行格式。',
  'line-endings-not-mixed': '当前文档已使用统一的换行格式。',
  'save-failed': '无法写入文件，请检查目标是否可写。',
  'read-failed': '无法读取文件。',
  'unsupported-file-type': '请选择 .md、.markdown 或 .txt 文档。',
  'workspace-invalid-name': '请输入有效名称。新建文档须以 .md、.markdown 或 .txt 结尾。',
  'workspace-invalid-path': '工作区相对路径无效。',
  'workspace-not-selected': '请先选择工作区文件夹。',
  'workspace-unavailable': '工作区文件夹已移除或不可访问，请重新选择。',
  'workspace-outside-root': '目标位于当前工作区文件夹之外。',
  'workspace-missing': '该文件或文件夹已移走、重命名或删除。',
  'workspace-read-failed': '无法读取工作区中的目标。',
  'workspace-linked-entry': '请在链接目标的位置操作该文件夹或文件。',
  'workspace-name-exists': '同一文件夹中已有同名项目。',
  'workspace-entry-open': '请先关闭打开此文件或其子文件的窗口，再移到回收站。',
  'workspace-rename-failed': '重命名失败，请检查权限或其他应用是否正在使用此项目。',
  'workspace-trash-failed': '无法移到系统回收站。',
  'workspace-reveal-failed': '无法在系统文件管理器中显示目标。',
  'workspace-too-many-links': '链接数量或长度超出检查范围。',
};

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return ERRORS[error] ?? fallback + '（' + error + '）';
  return fallback;
}

function localDocument(name: string, source: string, key: number): DocumentView {
  return {
    key, name, path: null, source, initialSource: source, revision: 0,
    format: { bomByteLength: 0, lineEnding: 'lf', hasTrailingLineEnding: source.endsWith('\n') },
  };
}

export function downloadMarkdown(view: DocumentView, current: string): void {
  const content = view.format.lineEnding === 'mixed' || current === view.initialSource
    ? view.source : editorToMarkdownText(current, view.format.lineEnding);
  const bytes = Uint8Array.from(encodeMarkdownBytes(content, view.format.bomByteLength));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = view.name.replace(/\.(?:md|markdown|txt)$/iu, '') + '.md';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function useDocument(surface: RefObject<SourceSurfaceHandle | null>, previewInputActive?: () => boolean,
  onConfirmClose?: () => void) {
  const desktop = isTauri();
  const [view, setView] = useState(() => localDocument(desktop ? '未命名.md' : '示例.md', desktop ? '' : EXAMPLE, 0));
  const [source, setSource] = useState(view.initialSource);
  const [selection, setSelection] = useState(START_SELECTION);
  const [draftDirty, setDraftDirty] = useState(false);
  const [pending, setPending] = useState(desktop);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [recent, setRecent] = useState<RecentDocument[]>([]);
  const [drafts, setDrafts] = useState<RecoveryDraft[]>([]);
  const [workspaceLocation, setWorkspaceLocation] = useState<WorkspaceLocation | null>(null);
  const operation = useRef(false);
  const editVersion = useRef(0);
  const keyCounter = useRef(0);
  const draftWork = useRef<Promise<unknown>>(Promise.resolve());
  const dirtyDraft = useRef<string | null>(null);
  const lastDiskStatus = useRef<WorkspaceDiskStatus>('unchanged');
  const startup = useRef<Promise<NativeDocument> | null>(null);
  const protection = useRef({ dirty: false, saving: false });
  const previewInput = useRef(previewInputActive);
  previewInput.current = previewInputActive;
  const dirty = draftDirty || source !== view.initialSource;
  protection.current = { dirty, saving: pending };

  function applyOpened(opened: NativeDocument) {
    const normalized = markdownToEditorText(opened.source);
    const initialSource = opened.recovered ? markdownToEditorText(opened.baseSource ?? '') : normalized;
    keyCounter.current += 1;
    editVersion.current += 1;
    setView({ ...opened, key: keyCounter.current, initialSource });
    setSource(normalized);
    setDraftDirty(Boolean(opened.recovered || opened.formatChanged));
    setSelection(START_SELECTION);
    setConflict(false);
    lastDiskStatus.current = 'unchanged';
  }

  async function refreshLists() {
    if (!desktop) return;
    const results = await Promise.allSettled([
      invoke<RecentDocument[]>('recent_markdown'),
      invoke<RecoveryDraft[]>('recover_markdown_drafts'),
    ]);
    if (results[0].status === 'fulfilled') setRecent(results[0].value);
    if (results[1].status === 'fulfilled') setDrafts(results[1].value);
  }

  useEffect(() => {
    if (!desktop) {
      function beforeUnload(event: BeforeUnloadEvent) {
        if (!protection.current.dirty && !surface.current?.composing() && !previewInput.current?.()) return;
        event.preventDefault();
        event.returnValue = '';
      }
      window.addEventListener('beforeunload', beforeUnload);
      return () => window.removeEventListener('beforeunload', beforeUnload);
    }

    let active = true;
    const nativeWindow = getCurrentWindow();
    startup.current ??= invoke<NativeDocument | null>('current_document')
      .then(opened => opened ?? invoke<NativeDocument>('new_markdown'));
    void startup.current.then(opened => {
      if (active) applyOpened(opened);
    }, reason => {
      if (active) setError(errorMessage(reason, '无法初始化文档会话。'));
    }).finally(() => {
      if (active) {
        setPending(false);
        void refreshLists();
        void invoke<WorkspaceLocation | null>('workspace_initial_location').then(location => {
          if (active && location) setWorkspaceLocation(location);
        }).catch(reason => {
          if (active) setError(errorMessage(reason, '无法定位搜索结果。'));
        });
      }
    });
    const subscriptions = [
      nativeWindow.onCloseRequested(async event => {
        event.preventDefault();
        if (protection.current.saving || operation.current || surface.current?.composing() || previewInput.current?.()) {
          setNotice('请先完成当前操作或输入法候选。');
          return;
        }
        if (protection.current.dirty) {
          onConfirmClose?.();
          return;
        }
        if (operation.current) return;
        operation.current = true;
        try {
          await closeDraft.current();
          await nativeWindow.destroy();
        } catch (reason) {
          operation.current = false;
          setError(errorMessage(reason, '无法关闭窗口。'));
        }
      }),
      listen<string>('extendown://document-open-error', event => {
        if (active) setError(errorMessage(event.payload, '无法打开拖入的文件。'));
      }),
      listen<WorkspaceLocation>('extendown://workspace-location', event => {
        if (active) setWorkspaceLocation(event.payload);
      }),
      listen<{ documentId: string; path: string; name: string }>('extendown://workspace-renamed', event => {
        if (!active) return;
        const { documentId, path, name } = event.payload;
        setView(previous => previous.documentId === documentId ? { ...previous, path, name } : previous);
        void refreshLists();
      }),
    ];
    for (const subscription of subscriptions) {
      void subscription.catch(reason => {
        if (active) setError(errorMessage(reason, '无法注册窗口事件。'));
      });
    }
    return () => {
      active = false;
      for (const subscription of subscriptions) void subscription.then(unlisten => unlisten()).catch(() => undefined);
    };
  }, [desktop, onConfirmClose, surface]);

  useEffect(() => {
    if (!desktop || !view.documentId) return;
    const documentId = view.documentId;
    if (!dirty && dirtyDraft.current !== documentId) return;
    dirtyDraft.current = dirty ? documentId : null;
    const timer = window.setTimeout(() => {
      if (operation.current) return;
      const command = dirty ? 'write_markdown_draft' : 'clear_markdown_draft';
      draftWork.current = draftWork.current.then(() => invoke(command, {
        documentId, source, revision: view.revision,
      })).catch(reason => {
        setError(errorMessage(reason, '无法更新恢复草稿。'));
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [desktop, view.documentId, view.path, view.revision, source, dirty, pending]);

  function canLeaveInput(): boolean {
    if (!surface.current?.composing() && !previewInput.current?.()) return true;
    setNotice('请先完成当前输入。');
    return false;
  }

  async function perform<T>(action: () => Promise<T>, fallback: string) {
    if (operation.current || pending || !canLeaveInput()) return;
    operation.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await draftWork.current;
      return await action();
    } catch (reason) {
      setConflict(reason === 'external-change' || reason === 'revision-conflict');
      setError(errorMessage(reason, fallback));
    } finally {
      operation.current = false;
      setPending(false);
    }
  }

  async function keepDraft() {
    await draftWork.current;
    if (desktop && dirty && view.documentId) {
      await invoke('write_markdown_draft', {
        documentId: view.documentId, source: surface.current?.text() ?? source, revision: view.revision,
      });
    } else if (desktop && view.documentId) {
      await invoke('clear_markdown_draft', { documentId: view.documentId });
    }
  }
  const closeDraft = useRef(keepDraft);
  closeDraft.current = keepDraft;

  async function closeKeepingDraft() {
    if (operation.current || protection.current.saving) return false;
    operation.current = true;
    setPending(true);
    try {
      await closeDraft.current();
      await getCurrentWindow().destroy();
      return true;
    } catch (reason) {
      operation.current = false;
      setPending(false);
      setError(errorMessage(reason, '无法关闭窗口。'));
      return false;
    }
  }

  async function replace(action: () => Promise<NativeDocument | null>) {
    await perform(async () => {
      if (dirty && !window.confirm(desktop ? '切换文档并保留当前恢复草稿？' : '放弃当前未保存的修改？')) return;
      await keepDraft();
      const opened = await action();
      if (opened) applyOpened(opened);
      await refreshLists();
      return opened;
    }, '无法打开文档。');
  }

  async function openBrowserFile(file: File) {
    await replace(async () => {
      if (!/\.(?:md|markdown|txt)$/iu.test(file.name)) throw new Error(ERRORS['unsupported-file-type']);
      if (file.size > 2 * 1024 * 1024) throw new Error('浏览器入口最多打开 2 MiB 的文档。');
      const opened = decodeMarkdownBytes(new Uint8Array(await file.arrayBuffer()));
      return { documentId: '', name: file.name, path: null, source: opened.content, format: opened.format, revision: 0 };
    });
  }

  function normalizeLineEndings(lineEnding: UniformLineEnding) {
    return perform(async () => {
      if (view.format.lineEnding !== 'mixed') return;
      const converted = desktop
        ? await invoke<NativeDocument>('normalize_markdown_line_endings', {
          documentId: view.documentId, revision: view.revision, lineEnding,
        })
        : { source: editorToMarkdownText(view.source, lineEnding), format: { ...view.format, lineEnding } };
      editVersion.current += 1;
      setView(previous => ({ ...previous, ...converted }));
      setDraftDirty(true);
      setNotice(`已统一为 ${lineEnding.toUpperCase()}，${desktop ? '保存后写入文件。' : '现在可以编辑或下载副本。'}`);
      return true;
    }, '无法统一换行格式。');
  }

  async function save(asCopy = false) {
    await perform(async () => {
      const snapshot = surface.current?.text() ?? source;
      if (!desktop) {
        downloadMarkdown(view, snapshot);
        setNotice('已请求下载 Markdown 副本。');
        return;
      }
      const version = editVersion.current;
      const saved = await invoke<NativeDocument | null>(asCopy || !view.path ? 'save_markdown_as' : 'save_markdown', {
        documentId: view.documentId || null, source: snapshot, revision: view.revision,
      });
      if (!saved) return;
      setView(previous => ({ ...previous, ...saved, initialSource: markdownToEditorText(saved.source) }));
      if (editVersion.current === version) setDraftDirty(false);
      setConflict(false);
      setNotice('已保存 ' + saved.name);
      await refreshLists();
    }, '无法保存文档。');
  }

  function edit(value: string, selected: SourceSelection) {
    editVersion.current += 1;
    setSource(value);
    setSelection(selected);
  }

  function noteWorkspaceDiskStatus(status: WorkspaceDiskStatus) {
    if (status === lastDiskStatus.current) return;
    lastDiskStatus.current = status;
    if (status === 'unchanged') return;
    setConflict(true);
    setError(status === 'missing'
      ? '当前文件已在工作区外部移动、重命名或删除。可将当前草稿另存。'
      : ERRORS['external-change']);
  }

  async function openWorkspaceFile(workspaceId: string, relative: string, newWindow = false, line?: number) {
    const request = () => invoke<NativeDocument | null>('workspace_open', { workspaceId, relative, newWindow, line });
    if (newWindow) {
      await perform(request, '无法在新窗口打开文档。');
    } else {
      await replace(async () => {
        const opened = await request();
        if (opened && line !== undefined) setWorkspaceLocation({ documentId: opened.documentId, line });
        return opened;
      });
    }
  }

  function renameWorkspaceEntry(workspaceId: string, relative: string, name: string) {
    return perform(async () => {
      if (dirty && view.documentId) {
        await invoke('write_markdown_draft', {
          documentId: view.documentId, source: surface.current?.text() ?? source, revision: view.revision,
        });
      }
      await invoke('workspace_rename', { workspaceId, relative, name });
      return true;
    }, '无法重命名项目。');
  }

  const resolveImage = useMemo(() => {
    const documentId = view.documentId;
    if (!documentId || !view.path) return undefined;
    return (reference: string) => invoke<string | null>('read_document_image', { documentId, reference });
  }, [view.documentId, view.path]);

  return {
    desktop, view, source, selection, setSelection, dirty, pending, notice, setNotice, error, setError, conflict, recent, drafts,
    canLeaveInput, closeKeepingDraft, edit, openBrowserFile, normalizeLineEndings, save, perform,
    openWorkspaceFile, renameWorkspaceEntry, workspaceLocation, noteWorkspaceDiskStatus,
    open: () => replace(() => invoke('open_markdown')),
    newDocument: () => replace(() => desktop ? invoke('new_markdown') : Promise.resolve({
      documentId: '', name: '未命名.md', path: null, source: '', format: localDocument('', '', 0).format, revision: 0,
    })),
    newWindow: () => perform(() => invoke('new_document_window'), '无法新建窗口。'),
    reload: () => perform(async () => {
      if (dirty && !window.confirm('重新载入磁盘内容并保留当前恢复草稿？')) return;
      await keepDraft();
      applyOpened(await invoke<NativeDocument>('reload_markdown', { documentId: view.documentId }));
      await refreshLists();
    }, '无法重新载入文档。'),
    openRecent: (id: string) => replace(() => invoke('open_recent_markdown', { id })),
    restore: (id: string) => replace(() => invoke('restore_markdown_draft', { id })),
    discard: (id: string) => perform(async () => {
      await invoke('discard_markdown_draft', { id });
      await refreshLists();
    }, '无法移除恢复草稿。'),
    refreshLists,
    currentSource: () => surface.current?.text() ?? source,
    currentRevision: () => editVersion.current,
    resolveImage,
  };
}
