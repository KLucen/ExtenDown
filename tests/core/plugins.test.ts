import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { builtinExporterModules, builtinMathModule, mathMarkdownExtension } from '../../src/core/plugins/builtin.ts';
import { builtinFocusModule } from '../../src/core/plugins/focus-view.ts';
import { builtinSampleThemeModule, sampleTheme } from '../../src/core/plugins/official-theme.ts';
import { PluginRegistry } from '../../src/core/plugins/registry.ts';
import { createThemeModule, readThemePlugin, validateThemePlugin } from '../../src/core/plugins/theme-package.ts';
import { PluginValidationError, validatePluginManifest, validateThemeContribution } from '../../src/core/plugins/validation.ts';

const theme = {
  id: 'org.example.midnight',
  name: 'Midnight',
  tokens: {
    surface: '#101216', text: '#f5f7fa', mutedText: '#a9b0bd', accent: '#7db6ff',
    border: '#303743', codeSurface: '#171b22', fontFamily: 'system-ui, sans-serif', readingWidth: '68rem',
  },
};

test('validates manifests and rejects unsafe package paths', () => {
  const manifest = validatePluginManifest({ schemaVersion: 1, id: 'org.example.theme', name: 'Theme', version: '1.0.0', hostApi: '^1.0.0', kind: 'theme', entry: 'theme.json', contributes: ['theme:example'], permissions: [], dependencies: {} });
  assert.equal(manifest.id, 'org.example.theme');
  assert.throws(() => validatePluginManifest({ ...manifest, entry: '../plugin.js' }), PluginValidationError);
  assert.throws(() => validatePluginManifest({ ...manifest, id: 'Org/Bad' }), PluginValidationError);
});

test('theme validation accepts safe tokens and rejects executable CSS', () => {
  assert.equal(validateThemeContribution(theme).tokens.surface, '#101216');
  assert.throws(() => validateThemeContribution({ ...theme, tokens: { ...theme.tokens, surface: 'url(https://evil.invalid)' } }), PluginValidationError);
  assert.throws(() => validateThemeContribution({ ...theme, tokens: { ...theme.tokens, custom: '#fff' } }), PluginValidationError);
});

test('registry activates builtins, orders contributions, and disposes on deactivate', () => {
  const registry = new PluginRegistry();
  assert.equal(registry.activate(builtinMathModule), true);
  assert.equal(registry.list('markdown')[0], mathMarkdownExtension);
  assert.equal(mathMarkdownExtension.detect('before\n$$\nx^2\n$$\nafter'), true);
  assert.equal(mathMarkdownExtension.detect('ordinary text'), false);
  assert.equal(registry.activate(builtinMathModule), false);
  assert.equal(registry.deactivate(builtinMathModule.manifest.id), true);
  assert.equal(registry.list('markdown').length, 0);
  assert.equal(registry.manifestsSnapshot().length, 0);
  assert.equal(registry.diagnosticsSnapshot()[0]?.code, 'contribution-conflict');
});

test('core contribution IDs are reserved for core registration only', () => {
  const registry = new PluginRegistry({ markdown: [mathMarkdownExtension.id] });
  assert.doesNotThrow(() => registry.register('markdown', mathMarkdownExtension));
  assert.throws(() => registry.register('markdown', mathMarkdownExtension, 'org.example.other'));
});

test('invalid manifests become diagnostics instead of escaping activation', () => {
  const registry = new PluginRegistry();
  assert.equal(registry.activate({ ...builtinMathModule, manifest: { ...builtinMathModule.manifest, entry: '../bad' } }), false);
  assert.equal(registry.diagnosticsSnapshot()[0]?.code, 'manifest-invalid');
});

test('registry refuses missing dependencies without activating a module', () => {
  const registry = new PluginRegistry();
  const module = { ...builtinMathModule, manifest: { ...builtinMathModule.manifest, id: 'org.example.dependent', dependencies: { 'org.example.missing': '^1.0.0' } } };
  assert.equal(registry.activate(module), false);
  assert.equal(registry.list('markdown').length, 0);
  assert.equal(registry.diagnosticsSnapshot()[0]?.code, 'dependency-missing');
});

test('the official sample theme uses the same registry and validation contract', () => {
  const registry = new PluginRegistry();
  assert.equal(registry.activate(builtinSampleThemeModule), true);
  assert.equal(registry.list('theme')[0], sampleTheme);
});

const themeManifest = {
  schemaVersion: 1, name: 'Aurora', id: 'org.example.aurora', version: '1.0.0',
  hostApi: '^1.0.0', kind: 'theme', entry: 'theme.json', contributes: ['theme:aurora'], dependencies: {}, permissions: [],
};

function dataTheme(files: Record<string, Uint8Array<ArrayBuffer>> = {}) {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(themeManifest)),
    'theme.json': strToU8(JSON.stringify({ schemaVersion: 1, tokens: { text: '#203040', readingWidth: '65ch' } })),
    ...files,
  });
}

test('installs an offline data-only theme archive and validates it after persistence', () => {
  const installed = readThemePlugin(dataTheme());
  const registry = new PluginRegistry();
  assert.ok(registry.activate(createThemeModule(validateThemePlugin(JSON.parse(JSON.stringify(installed))))));
  assert.equal(registry.list('theme')[0]?.tokens.text, '#203040');
  assert.equal(registry.list('theme')[0]?.tokens.readingWidth, '65ch');
  assert.equal(registry.list('theme')[0]?.tokens.surface, '#ffffff');
});

test('rejects incompatible or privileged themes, traversal entries, and oversized archive members', () => {
  for (const manifest of [
    { ...themeManifest, hostApi: '^2.0.0' },
    { ...themeManifest, permissions: ['network.fetch'] },
  ]) {
    assert.throws(() => readThemePlugin(dataTheme({ 'manifest.json': strToU8(JSON.stringify(manifest)) })), PluginValidationError);
  }
  assert.throws(() => readThemePlugin(dataTheme({ '../evil.js': strToU8('script') })), PluginValidationError);
  assert.throws(() => readThemePlugin(dataTheme({ 'theme.json': new Uint8Array(20_000) })), PluginValidationError);
});

test('a manifest with an incompatible API cannot register a contribution', () => {
  const registry = new PluginRegistry();
  assert.equal(registry.activate({ ...builtinMathModule, manifest: { ...builtinMathModule.manifest, hostApi: '^2.0.0' } }), false);
  assert.equal(registry.list('markdown').length, 0);
  assert.equal(registry.diagnosticsSnapshot()[0]?.code, 'host-api-incompatible');
});

test('export formats and the focus view can be activated and removed independently', () => {
  const registry = new PluginRegistry();
  assert.ok(registry.activate(builtinFocusModule));
  assert.ok(registry.activate(builtinExporterModules.pdf));
  assert.ok(registry.activate(builtinExporterModules.jpg));
  assert.deepEqual(registry.list('render-mode').map(item => item.id), ['org.extendown.view.focus']);
  assert.deepEqual(registry.list('exporter').map(item => item.format), ['jpg', 'pdf']);
  assert.ok(registry.deactivate(builtinExporterModules.jpg.manifest.id));
  assert.deepEqual(registry.list('exporter').map(item => item.format), ['pdf']);
});
