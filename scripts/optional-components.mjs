import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_CATEGORIES, COMPONENT_PRESETS, OFFICIAL_COMPONENTS } from '../src/core/plugins/component-catalog.ts';

const output = fileURLToPath(new URL('../src-tauri/target/optional-components/', import.meta.url));
const portable = fileURLToPath(new URL('../src-tauri/target/release/extendown-components/', import.meta.url));
const groups = Object.fromEntries(OFFICIAL_COMPONENTS.map(item => [item.id, item.entries]));

function nsisCatalog() {
  const lines = [];
  const macro = (name, commands) => lines.push(`!macro ${name}`, ...commands.map(command => '  ' + command), '!macroend', '');
  for (const [name, command] of [
    ['DECLARE', 'ExtendownDeclare'], ['LOAD', 'ExtendownLoadChoice'],
    ['READ', 'ExtendownReadCheckbox'], ['SAVE', 'ExtendownSaveChoice'],
  ]) macro('EXTENDOWN_COMPONENT_' + name, OFFICIAL_COMPONENTS.map(item => `!insertmacro ${command} ${item.id}`));
  const choices = [];
  const columns = [['writing', 'view'], ['export', 'appearance']];
  for (const [column, categories] of columns.entries()) {
    let row = 32;
    const left = column === 0 ? 0 : 50;
    for (const category of categories) {
      choices.push(`!insertmacro ExtendownCategory "${COMPONENT_CATEGORIES[category]}" ${left}% ${row}u`);
      row += 12;
      for (const item of OFFICIAL_COMPONENTS.filter(item => item.category === category)) {
        choices.push(`!insertmacro ExtendownCheckbox ${item.id} "${item.name}" ${left + 2}% ${row}u`);
        row += 13;
      }
      row += 4;
    }
  }
  macro('EXTENDOWN_COMPONENT_CHECKS', choices);
  for (const [name, selected] of Object.entries(COMPONENT_PRESETS)) {
    macro('EXTENDOWN_COMPONENT_' + name.toUpperCase(), OFFICIAL_COMPONENTS.map(item =>
      `!insertmacro ExtendownSetCheck ${item.id} ${selected.includes(item.id) ? 1 : 0}`));
  }
  return lines.join('\n');
}

function reachable(bundle, starts, blocker = () => false) {
  const visited = new Set();
  const queue = [...starts];
  while (queue.length) {
    const name = queue.pop();
    const asset = bundle[name];
    if (!asset || visited.has(name) || blocker(name)) continue;
    visited.add(name);
    if (asset.type === 'chunk') {
      queue.push(...asset.imports, ...asset.dynamicImports);
      const metadata = asset.viteMetadata;
      if (metadata) queue.push(...metadata.importedCss, ...metadata.importedAssets);
    }
  }
  return visited;
}

function nsisInventory(assets) {
  const lines = [
    '!macro EXTENDOWN_COMPONENT_FILES',
    '  SetOutPath "$INSTDIR\\extendown-components\\assets"',
  ];
  for (const [file, { components }] of Object.entries(assets)) {
    const tests = components.map((group, index) => '  ${'+ (index === 0 ? 'If' : 'OrIf') + '} $pick_' + group + ' = 1');
    lines.push(...tests);
    lines.push('    File "${EXTENDOWN_FILES}\\' + file.replaceAll('/', '\\') + '"');
    lines.push('  ${EndIf}');
  }
  lines.push('!macroend', '');
  return lines.join('\n');
}

// Preserve Rollup's URLs while moving selected code out of Tauri's embedded
// frontend. The Windows host serves these files using the embedded manifest.
export function optionalComponents() {
  let active = false;
  return {
    name: 'extendown-optional-components',
    apply: 'build',
    configResolved(config) {
      active = config.mode === 'windows-components';
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
      if (!active) return;
      const entries = new Map();
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          for (const moduleId of item.moduleIds) {
            const id = moduleId.replaceAll('\\', '/').split('/').at(-1).replace(/\?.*$/u, '');
            if (Object.values(groups).some(entryIds => entryIds.includes(id))) entries.set(id, item.fileName);
          }
        }
      }
      for (const [group, entryIds] of Object.entries(groups)) {
        for (const entry of entryIds) {
          if (!entries.has(entry)) this.error('Component ' + group + ' missing entry: ' + entry);
          if (bundle[entries.get(entry)].isEntry) this.error('Optional entry is part of the mandatory app: ' + entry);
        }
      }
      const optionalRoots = new Set(Object.values(groups).flatMap(ids => ids.map(id => entries.get(id)).filter(Boolean)));
      const core = reachable(bundle, Object.values(bundle).filter(item => item.type === 'chunk' && item.isEntry).map(item => item.fileName),
        name => optionalRoots.has(name));
      const owners = new Map();
      for (const [group, ids] of Object.entries(groups)) {
        const roots = ids.map(id => entries.get(id));
        const ownRoots = new Set(roots);
        for (const file of reachable(bundle, roots, name => core.has(name) || (optionalRoots.has(name) && !ownRoots.has(name)))) {
          if (!/^assets\/[\w.-]+\.(?:js|css|woff2?|png|svg)$/u.test(file)) {
            this.error('Unsupported optional component filename: ' + file);
          }
          if (!owners.has(file)) owners.set(file, []);
          owners.get(file).push(group);
        }
      }
      const assetFolder = resolve(output, 'assets');
      mkdirSync(assetFolder, { recursive: true });
      for (const entry of readdirSync(assetFolder, { withFileTypes: true })) {
        if (entry.isFile()) unlinkSync(resolve(assetFolder, entry.name));
      }
      const assets = {};
      for (const [file, components] of [...owners.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const item = bundle[file];
        const contents = item.type === 'chunk' ? item.code : item.source;
        assets[file] = { sha256: createHash('sha256').update(contents).digest('hex'), components };
        writeFileSync(resolve(output, file), contents);
        delete bundle[file];
      }
      writeFileSync(resolve(output, 'component-files.nsh'), nsisInventory(assets));
      writeFileSync(resolve(output, 'component-catalog.nsh'), nsisCatalog());
      this.emitFile({ type: 'asset', fileName: 'optional-assets.json',
        source: JSON.stringify({ groups: Object.keys(groups), assets }) });
      this.info('Separated ' + owners.size + ' component assets from the Windows editor executable.');
      },
    },
    writeBundle() {
      if (!active) return;
      const folder = resolve(portable, 'assets');
      mkdirSync(folder, { recursive: true });
      for (const entry of readdirSync(resolve(output, 'assets'))) {
        writeFileSync(resolve(folder, entry), readFileSync(resolve(output, 'assets', entry)));
      }
      writeFileSync(resolve(portable, 'selection.ini'), '[components]\n' +
        Object.keys(groups).map(group => group + '=1\n').join(''));
    },
  };
}
