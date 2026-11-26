import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginPermission } from '../../src/core/plugins/contracts.ts';
import { sameScriptDocument, scriptCommandInput, scriptCommandResult, type ScriptDocument } from '../../src/core/plugins/script-command.ts';
import type { ScriptPluginRecord } from '../../src/core/plugins/script-store.ts';

const id = 'org.example.commands';
const document: ScriptDocument = {
  key: 1,
  revision: 2,
  source: '# 测试😀',
  format: { bomByteLength: 3, lineEnding: 'crlf', hasTrailingLineEnding: false },
};

function installed(permissions: PluginPermission[], enabled = true): ScriptPluginRecord {
  return {
    current: {
      manifest: {
        schemaVersion: 1, id, name: '测试命令', version: '1.0.0', hostApi: '^1.0.0',
        kind: 'command', entry: 'plugin.js', contributes: [id], permissions, dependencies: {},
      },
      source: 'function run() { return { message: "ok" }; }',
    },
    previous: null,
    enabled,
    generation: 'test-generation',
  };
}

test('only an enabled declared command receives its authorized snapshot fields', () => {
  assert.deepEqual(scriptCommandInput(installed([]), id, document), { command: id });
  assert.deepEqual(scriptCommandInput(installed(['document.read']), id, document), {
    command: id, document: { source: document.source, revision: document.revision },
  });
  assert.throws(() => scriptCommandInput(installed([], false), id, document));
  assert.throws(() => scriptCommandInput(installed(['document.read']), id, null));
  assert.throws(() => scriptCommandInput(installed([]), 'unknown', document));
});

test('the host rejects unauthorized or invalid Markdown candidates and caps saved UTF-8 size', () => {
  const transform = installed(['document.read', 'document.transform']);
  assert.deepEqual(scriptCommandResult({ message: '完成', source: '# 标题\n' }, transform, document), {
    message: '完成', source: '# 标题\n',
  });
  assert.throws(() => scriptCommandResult({ source: '' }, installed(['document.read']), document));
  for (const source of ['\uFEFFtitle', 'title\r\n', 'title\0', '\ud800', '\n'.repeat(1024 * 1024)]) {
    assert.throws(() => scriptCommandResult({ source }, transform, document));
  }
  assert.throws(() => scriptCommandResult({ source: 'title' }, transform, {
    ...document, format: { ...document.format, lineEnding: 'mixed' },
  }));
  assert.throws(() => scriptCommandResult({ html: '<b>no</b>' }, transform, document));
});

test('review is invalidated by document replacement, an intervening edit or a file format change', () => {
  assert.ok(sameScriptDocument({ ...document }, document));
  assert.equal(sameScriptDocument({ ...document, key: 2 }, document), false);
  assert.equal(sameScriptDocument({ ...document, revision: 3 }, document), false);
  assert.equal(sameScriptDocument({ ...document, format: { ...document.format } }, document), false);
});
