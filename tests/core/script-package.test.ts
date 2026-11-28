import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { MAX_PLUGIN_SOURCE_BYTES } from '../../src/core/plugins/plugin-archive.ts';
import { readPluginPackage } from '../../src/core/plugins/plugin-package.ts';
import { readScriptPlugin, validateScriptPlugin } from '../../src/core/plugins/script-package.ts';
import { PluginValidationError } from '../../src/core/plugins/validation.ts';

const manifest = {
  schemaVersion: 1, id: 'org.example.markdown-tools', name: '排版工具', version: '1.0.0',
  hostApi: '^1.0.0', kind: 'command', entry: 'plugin.js', contributes: ['org.example.markdown-tools.trim'],
  permissions: ['document.read', 'document.transform'], dependencies: {},
};
const source = 'function run(input) { return { message: "排版完成" }; }';
const manifestEntry = strToU8(JSON.stringify(manifest));
const scriptEntry = strToU8(source);

test('the installer distinguishes command and theme packages without running their contents', () => {
  const commandZip = zipSync({ 'manifest.json': manifestEntry, 'plugin.js': scriptEntry });
  const command = readPluginPackage(commandZip);
  assert.ok('source' in command);
  assert.equal(command.source, source);
  assert.deepEqual(command, readScriptPlugin(commandZip));
  assert.deepEqual(command, validateScriptPlugin(JSON.parse(JSON.stringify(command))));
  const themeZip = zipSync({
    'manifest.json': strToU8(JSON.stringify({
      ...manifest, kind: 'theme', entry: 'theme.json', contributes: [manifest.id], permissions: [],
    })),
    'theme.json': strToU8(JSON.stringify({ tokens: { surface: '#eeffff' } })),
    'preview.png': new Uint8Array([0, 1, 2]),
  });
  const theme = readPluginPackage(themeZip);
  assert.ok('theme' in theme);
  assert.equal(theme.theme.tokens.surface, '#eeffff');
  assert.throws(() => readScriptPlugin(themeZip), PluginValidationError);
});

test('script package validation refuses privileged, ambiguous, or incompatible declarations', () => {
  const invalid = [
    { permissions: ['network.fetch'] },
    { permissions: ['export.create'] },
    { permissions: ['document.transform'] },
    { permissions: ['document.read', 'document.read'] },
    { hostApi: '^2.0.0' },
    { dependencies: { 'org.example.other': '1.0.0' } },
    { entry: '../plugin.js' },
    { name: 'Hello\nPowers' },
    { name: 'Hide\u202Etext' },
    { id: 'org.extendown.code' },
    { contributes: ['org.example.someone-else'] },
    { contributes: [`command:${manifest.id}.trim`] },
  ];
  for (const item of invalid) {
    assert.throws(() => validateScriptPlugin({ manifest: { ...manifest, ...item }, source }), PluginValidationError);
  }
});

test('command labels are optional and restricted to the plugin declared commands', () => {
  const commandId = manifest.contributes[0];
  const valid = validateScriptPlugin({
    manifest: { ...manifest, commandLabels: { [commandId]: '整理空白' } },
    source,
  });
  assert.equal(valid.manifest.commandLabels?.[commandId], '整理空白');
  for (const commandLabels of [
    { 'org.example.markdown-tools.unknown': '未知命令' },
    { [commandId]: '双向覆盖\u202e' },
    { [commandId]: 'a'.repeat(81) },
  ]) {
    assert.throws(() => validateScriptPlugin({
      manifest: { ...manifest, commandLabels }, source,
    }), PluginValidationError);
  }
});

test('script package extraction enforces the root entry set and UTF-8 byte limits', () => {
  for (const entries of [
    { 'theme.json': new Uint8Array([0]) },
    { 'preview.png': new Uint8Array([0]) },
    { '../plugin.js': scriptEntry },
    { 'plugin.js': new Uint8Array([0xff]) },
    { 'plugin.js': new Uint8Array(MAX_PLUGIN_SOURCE_BYTES + 1).fill(97) },
  ]) {
    assert.throws(() => readScriptPlugin(zipSync({ 'manifest.json': manifestEntry, 'plugin.js': scriptEntry, ...entries })), PluginValidationError);
  }
  assert.throws(() => validateScriptPlugin({ manifest, source: '字'.repeat(45_000) }), PluginValidationError);
});
