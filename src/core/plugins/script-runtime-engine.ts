import quickJsVariant from '@jitl/quickjs-singlefile-browser-release-sync';
import {
  newQuickJSWASMModuleFromVariant, Scope, type QuickJSContext, type QuickJSHandle,
} from 'quickjs-emscripten-core';
import {
  exceedsUtf8Limit, MAX_SCRIPT_RESULT_BYTES, PluginExecutionError, type ScriptInput,
} from './script-runtime-protocol.ts';

const HEAP_LIMIT_BYTES = 48 * 1024 * 1024;
const STACK_LIMIT_BYTES = 512 * 1024;
const EXECUTION_LIMIT_MS = 1_000;

let engine: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;

// Capture the JSON and prototype operations before loading the guest. Both
// the command and serialization run inside QuickJS under the same limits.
const INVOKE_COMMAND = `(() => {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const prototypeOf = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  return (input) => {
    if (typeof run !== 'function') return '';
    const result = run(parse(input));
    if (result === null || typeof result !== 'object') return '';
    const prototype = prototypeOf(result);
    if (prototype !== objectPrototype && prototype !== null) return '';
    const serialized = stringify(result);
    return typeof serialized === 'string' && serialized.length <= ${MAX_SCRIPT_RESULT_BYTES} ? serialized : '';
  };
})()`;

export async function evaluateScriptPlugin(script: string, input: ScriptInput): Promise<string> {
  const module = await (engine ??= newQuickJSWASMModuleFromVariant(quickJsVariant)).catch(() => {
    throw new PluginExecutionError('runtime-unavailable');
  });

  return Scope.withScope(scope => {
    const runtime = scope.manage(module.newRuntime());
    runtime.setMemoryLimit(HEAP_LIMIT_BYTES);
    runtime.setMaxStackSize(STACK_LIMIT_BYTES);
    const deadline = performance.now() + EXECUTION_LIMIT_MS;
    runtime.setInterruptHandler(() => performance.now() >= deadline);

    const context = scope.manage(runtime.newContext());
    function value(result: ReturnType<QuickJSContext['evalCode']>): QuickJSHandle {
      scope.manage(result);
      if (result.error) throw new PluginExecutionError(performance.now() >= deadline ? 'timeout' : 'script-failed');
      return result.value;
    }

    const runCommand = value(context.evalCode(INVOKE_COMMAND, 'extendown-command.js', { type: 'global' }));
    value(context.evalCode(script, 'plugin.js', { type: 'global' }));
    const payload = scope.manage(context.newString(JSON.stringify(input)));
    const result = value(context.callFunction(runCommand, context.undefined, payload));
    if (performance.now() >= deadline) throw new PluginExecutionError('timeout');
    const output = context.getString(result);
    if (!output.startsWith('{') || exceedsUtf8Limit(output, MAX_SCRIPT_RESULT_BYTES)) {
      throw new PluginExecutionError('invalid-result');
    }
    return output;
  });
}
