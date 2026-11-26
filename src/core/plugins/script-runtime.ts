import { MAX_PLUGIN_SOURCE_BYTES } from './plugin-archive.ts';
import {
  exceedsUtf8Limit, MAX_SCRIPT_DOCUMENT_BYTES, MAX_SCRIPT_RESULT_BYTES,
  PluginExecutionError, SCRIPT_PROTOCOL, type ScriptInput, type ScriptReply, type ScriptRequest,
} from './script-runtime-protocol.ts';

export { PluginExecutionError } from './script-runtime-protocol.ts';

const WORKER_TIMEOUT_MS = 5_000;

export async function runScriptPlugin(script: string, input: ScriptInput, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new PluginExecutionError('aborted');
  const { command, document } = input;
  if (exceedsUtf8Limit(script, MAX_PLUGIN_SOURCE_BYTES) || !script.trim() || script.includes('\0') ||
      !command || exceedsUtf8Limit(command, 200) ||
      (document && (!Number.isSafeInteger(document.revision) || document.revision < 0 ||
        exceedsUtf8Limit(document.source, MAX_SCRIPT_DOCUMENT_BYTES)))) {
    throw new PluginExecutionError('invalid-input');
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./script-runtime.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    throw new PluginExecutionError('runtime-unavailable');
  }

  const request: ScriptRequest = {
    protocol: SCRIPT_PROTOCOL,
    script,
    input: document
      ? { command, document: { source: document.source, revision: document.revision } }
      : { command },
  };

  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
    }
    function fail(error: PluginExecutionError) {
      cleanup();
      reject(error);
    }
    function cancel() { fail(new PluginExecutionError('aborted')); }

    const timeout = setTimeout(() => fail(new PluginExecutionError('timeout')), WORKER_TIMEOUT_MS);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = () => fail(new PluginExecutionError('runtime-unavailable'));
    worker.onmessageerror = () => fail(new PluginExecutionError('invalid-result'));
    worker.onmessage = (event: MessageEvent<ScriptReply>) => {
      const reply = event.data;
      if (reply?.protocol !== SCRIPT_PROTOCOL) {
        fail(new PluginExecutionError('invalid-result'));
      } else if (!reply.ok) {
        fail(new PluginExecutionError(reply.code));
      } else if (typeof reply.output !== 'string' || exceedsUtf8Limit(reply.output, MAX_SCRIPT_RESULT_BYTES)) {
        fail(new PluginExecutionError('invalid-result'));
      } else {
        try {
          const output: unknown = JSON.parse(reply.output);
          cleanup();
          resolve(output);
        } catch {
          fail(new PluginExecutionError('invalid-result'));
        }
      }
    };

    try {
      worker.postMessage(request);
    } catch {
      fail(new PluginExecutionError('runtime-unavailable'));
    }
  });
}
