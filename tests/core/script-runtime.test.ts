import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PLUGIN_SOURCE_BYTES } from '../../src/core/plugins/plugin-archive.ts';
import { evaluateScriptPlugin } from '../../src/core/plugins/script-runtime-engine.ts';
import { PluginExecutionError, runScriptPlugin } from '../../src/core/plugins/script-runtime.ts';

const input = { command: 'org.example.inspection' };

async function evaluate(source: string) {
  return JSON.parse(await evaluateScriptPlugin(source, input)) as unknown;
}

test('a script receives only its command input', async () => {
  const script = `function run(input) {
    return { command: input.command, keys: Object.keys(input), document: typeof input.document };
  }`;
  assert.deepEqual(await evaluate(script), {
    command: input.command, keys: ['command'], document: 'undefined',
  });
  const result = await evaluateScriptPlugin(
    'function run(input) { return { message: input.document.source, revision: input.document.revision }; }',
    { ...input, document: { source: '# 文档 😀', revision: 12 } },
  );
  assert.deepEqual(JSON.parse(result), { message: '# 文档 😀', revision: 12 });
});

test('the guest has no host browser, module, filesystem or IPC bindings', async () => {
  const result = await evaluate(`function run() {
    return {
      browser: [typeof fetch, typeof document, typeof self, typeof Worker, typeof XMLHttpRequest, typeof WebSocket],
      storage: [typeof localStorage, typeof indexedDB, typeof navigator, typeof caches],
      app: [typeof __TAURI_INTERNALS__, typeof process, typeof require, typeof postMessage],
    };
  }`);
  assert.deepEqual(result, {
    browser: Array(6).fill('undefined'), storage: Array(4).fill('undefined'), app: Array(4).fill('undefined'),
  });
});

test('missing or asynchronous command results are refused', async () => {
  for (const script of ['let count = 1', 'async function run() { return { message: "value" }; }',
    'function run() { return "value"; }']) {
    await assert.rejects(evaluate(script), {
      name: PluginExecutionError.name, code: 'invalid-result',
    });
  }
});

test('guest failure does not affect the next command context', async () => {
  await assert.rejects(evaluate('globalThis.state = 42; throw new Error("QA");'), {
    name: PluginExecutionError.name, code: 'script-failed',
  });
  assert.deepEqual(await evaluate('function run() { return { state: typeof state }; }'), { state: 'undefined' });
});

test('commands are bounded during execution and serialization', async () => {
  await assert.rejects(evaluate('function run() { for (;;) {} }'), { code: 'timeout' });
  await assert.rejects(evaluate('function run() { return { size: new ArrayBuffer(64 * 1024 * 1024).byteLength }; }'), {
    code: 'script-failed',
  });
  await assert.rejects(evaluate('function run() { return { value: "x".repeat(9 * 1024 * 1024) }; }'), {
    code: 'invalid-result',
  });
});

test('native Worker setup is skipped when cancelled or outside input limits', async () => {
  await assert.rejects(runScriptPlugin('function run() { return {}; }', input, AbortSignal.abort()), { code: 'aborted' });
  await assert.rejects(runScriptPlugin('x'.repeat(MAX_PLUGIN_SOURCE_BYTES + 1), input), { code: 'invalid-input' });
  await assert.rejects(runScriptPlugin('function run() { return {}; }', {
    ...input, document: { source: '文'.repeat(1024 * 1024), revision: 1 },
  }), { code: 'invalid-input' });
});
