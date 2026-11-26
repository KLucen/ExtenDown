import { evaluateScriptPlugin } from './script-runtime-engine.ts';
import { PluginExecutionError, SCRIPT_PROTOCOL, type ScriptReply, type ScriptRequest } from './script-runtime-protocol.ts';

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.addEventListener('message', async (event: MessageEvent<ScriptRequest>) => {
  const { protocol, script, input } = event.data;
  let reply: ScriptReply;
  try {
    if (protocol !== SCRIPT_PROTOCOL) throw new PluginExecutionError('invalid-input');
    reply = { protocol, ok: true, output: await evaluateScriptPlugin(script, input) };
  } catch (error) {
    const code = error instanceof PluginExecutionError ? error.code : 'script-failed';
    reply = { protocol: SCRIPT_PROTOCOL, ok: false, code };
  }
  worker.postMessage(reply);
}, { once: true });
