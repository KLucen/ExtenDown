import { useEffect, useRef, useState } from 'react';
import {
  SCRIPT_PERMISSION_LABELS, sameScriptDocument, scriptCommandInput, scriptCommandResult,
  type ScriptCommandResult, type ScriptDocument,
} from '../core/plugins/script-command.ts';
import {
  getScriptPlugin, listScriptPlugins, setScriptPluginEnabled, subscribeToScriptPlugins,
  type ScriptPluginRecord,
} from '../core/plugins/script-store.ts';

export function useScriptPlugins() {
  const [records, setRecords] = useState<ScriptPluginRecord[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let request = 0;
    function refresh() {
      const id = ++request;
      void listScriptPlugins().then(result => {
        if (!active || id !== request) return;
        setRecords(result);
        setError('');
      }, () => {
        if (!active || id !== request) return;
        setRecords([]);
        setError('无法读取本地命令插件。');
      });
    }
    const unsubscribe = subscribeToScriptPlugins(refresh);
    refresh();
    return () => { active = false; unsubscribe(); };
  }, []);
  return { records, error };
}

export interface ScriptRunEntry {
  readonly time: number;
  readonly command: string;
  readonly version: string;
  readonly status: '完成' | '失败' | '取消';
}

export function permissionDescriptions(plugin: ScriptPluginRecord['current']): string[] {
  return plugin.manifest.permissions.map(permission =>
    SCRIPT_PERMISSION_LABELS[permission as keyof typeof SCRIPT_PERMISSION_LABELS]);
}

interface Candidate {
  readonly record: ScriptPluginRecord;
  readonly document: ScriptDocument | null;
  readonly result: ScriptCommandResult;
}

async function requireEnabled(record: ScriptPluginRecord) {
  const current = await getScriptPlugin(record.current.manifest.id);
  if (!current?.enabled || current.generation !== record.generation) throw new Error('插件授权已变更，请重新运行命令。');
  return current;
}

export function ScriptCommands({ records, readDocument, replaceText, history, onRunEntry, onClose, initialCommand }: {
  records: readonly ScriptPluginRecord[];
  initialCommand?: string;
  readDocument: () => ScriptDocument | null;
  replaceText: (source: string) => boolean;
  history: readonly ScriptRunEntry[];
  onRunEntry: (entry: ScriptRunEntry) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const running = useRef<AbortController | null>(null);
  const selectedPlugin = useRef<ScriptPluginRecord | null>(null);
  const started = useRef(false);
  const [command, setCommand] = useState(initialCommand ?? '');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState<ScriptPluginRecord | null>(null);
  const latest = useRef({ readDocument, replaceText });
  latest.current = { readDocument, replaceText };

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { running.current?.abort(); };
  }, []);

  useEffect(() => {
    function revoke() {
      const record = selectedPlugin.current;
      if (record) void requireEnabled(record).catch(() => {
        if (selectedPlugin.current !== record) return;
        selectedPlugin.current = null;
        running.current?.abort();
        setCandidate(null);
        setError('插件授权已变更，请重新运行命令。');
      });
    }
    return subscribeToScriptPlugins(revoke);
  }, []);

  const commands = records.filter(record => record.enabled).flatMap(record =>
    record.current.manifest.contributes.map(id => ({ id, record })));
  const selected = commands.find(item => item.id === command) ?? (command === initialCommand ? undefined : commands[0]);

  async function run() {
    if (!selected || running.current || applying) return;
    const controller = new AbortController();
    const entry = { time: Date.now(), command: selected.id, version: selected.record.current.manifest.version };
    let completed = false;
    running.current = controller;
    selectedPlugin.current = selected.record;
    setCandidate(null);
    setError('');
    setStatus('');
    setFailed(null);
    setBusy(true);
    try {
      const runtime = await import('../core/plugins/script-runtime.ts');
      const record = await requireEnabled(selected.record);
      if (controller.signal.aborted) return;
      const document = latest.current.readDocument();
      const input = scriptCommandInput(record, selected.id, document);
      const raw = await runtime.runScriptPlugin(record.current.source, input, controller.signal);
      await requireEnabled(record);
      if (controller.signal.aborted) return;
      const result = scriptCommandResult(raw, record, document);
      if (result.source !== undefined && document && !sameScriptDocument(latest.current.readDocument(), document)) {
        throw new Error('文档已变更。请在当前修订上重新运行命令。');
      }
      setCandidate({ record, document, result });
      setStatus(result.source !== undefined && result.source === document?.source ? '插件返回的源码与当前文档相同。' : '命令执行完成。');
      completed = true;
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '插件执行失败。');
        setFailed(selected.record);
      }
    } finally {
      onRunEntry({ ...entry, status: controller.signal.aborted ? '取消' : completed ? '完成' : '失败' });
      if (running.current === controller) {
        running.current = null;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    if (!initialCommand || selected?.id !== initialCommand) return;
    let active = true;
    queueMicrotask(() => {
      if (!active || started.current) return;
      started.current = true;
      void run();
    });
    return () => { active = false; };
  }, [initialCommand, selected?.id]);

  async function apply() {
    if (applying || !candidate?.document || candidate.result.source === undefined) return;
    setApplying(true);
    setError('');
    try {
      await requireEnabled(candidate.record);
      if (!sameScriptDocument(latest.current.readDocument(), candidate.document) ||
        !latest.current.replaceText(candidate.result.source)) {
        throw new Error('文档状态已变更。请重新运行命令并审阅新的结果。');
      }
      setCandidate(null);
      setStatus('已将变更应用到草稿。');
    } catch (reason) {
      setCandidate(null);
      setError(reason instanceof Error ? reason.message : '无法应用结果。');
    } finally {
      setApplying(false);
    }
  }

  async function disableFailed() {
    if (!failed) return;
    try {
      const { id, version } = failed.current.manifest;
      await setScriptPluginEnabled(id, version, false, failed.generation);
      setFailed(null);
      setStatus('已停用该插件。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法停用插件。');
    }
  }

  const proposed = candidate?.result.source;
  const hasChange = proposed !== undefined && proposed !== candidate?.document?.source;
  return <dialog ref={dialog} className={hasChange ? 'settings-modal script-review-modal' : 'settings-modal'}
    aria-labelledby="script-command-title" onClose={onClose} onCancel={event => {
      event.preventDefault();
      if (!applying) dialog.current?.close();
    }}>
    <div className="modal-head">
      <h2 id="script-command-title">{hasChange ? '审阅文档变更' : '插件命令'}</h2>
      <button type="button" aria-label="关闭命令" disabled={applying} onClick={() => dialog.current?.close()}>×</button>
    </div>
    <div className="settings-section">
      {commands.length > 0 ? <>
        <label className="script-command-select">命令<select disabled={busy || applying} value={selected?.id ?? ''}
          onChange={event => { setCommand(event.target.value); setCandidate(null); setError(''); setStatus(''); setFailed(null); }}>
          {commands.map(item => <option key={item.id} value={item.id}>{item.record.current.manifest.name} · {item.id}</option>)}
        </select></label>
        <div className="dialog-actions">
          <button className="setting-action" type="button" disabled={!selected || busy || applying} onClick={() => void run()}>运行</button>
          {busy && <button className="setting-action" type="button" onClick={() => {
            running.current?.abort();
            setStatus('已取消命令。');
          }}>取消运行</button>}
          {failed && <button className="setting-action" type="button" onClick={() => void disableFailed()}>停用此插件</button>}
        </div>
      </> : <p>可在「设置 → 插件」安装并启用第三方命令插件。</p>}
      {busy && <p role="status">正在运行插件…</p>}
      {!busy && status && <p role="status">{status}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {candidate?.result.message !== undefined && <div>
        <strong>插件回执</strong>
        <p className="script-message">{candidate.result.message}</p>
      </div>}
      {hasChange && candidate?.document && <>
        <div className="script-review">
          <label>当前源码<textarea readOnly value={candidate.document.source} /></label>
          <label>插件建议<textarea readOnly value={proposed} /></label>
        </div>
        <div className="dialog-actions">
          <button className="setting-action" type="button" disabled={applying}
            onClick={() => { setCandidate(null); setStatus('已放弃插件变更。'); }}>放弃</button>
          <button className="setting-action" type="button" disabled={applying} onClick={() => void apply()}>应用变更</button>
        </div>
      </>}
      {history.length > 0 && <details className="script-run-history">
        <summary>本窗口运行记录</summary>
        <ul>{history.map((entry, index) => <li key={entry.time + ':' + index}>
          <time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toLocaleTimeString()}</time>
          {' '}{entry.command} · v{entry.version} · {entry.status}
        </li>)}</ul>
      </details>}
    </div>
  </dialog>;
}
