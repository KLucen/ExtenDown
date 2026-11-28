import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { OFFICIAL_COMPONENTS } from '../src/core/plugins/component-catalog.ts';

const output = fileURLToPath(new URL('../src-tauri/target/optional-components/available/', import.meta.url));
const groups = Object.fromEntries(OFFICIAL_COMPONENTS.map(item => [item.id, item.entries]));

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

function clearGeneratedFiles(folder) {
  mkdirSync(folder, { recursive: true });
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile()) unlinkSync(resolve(folder, entry.name));
  }
}

// Keep Rollup's URLs and publish the removed chunks as GitHub Release assets.
// The Windows host serves installed chunks using the embedded manifest.
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
      clearGeneratedFiles(output);
      const assets = {};
      for (const [file, components] of [...owners.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const item = bundle[file];
        const contents = item.type === 'chunk' ? item.code : item.source;
        assets[file] = { sha256: createHash('sha256').update(contents).digest('hex'), components };
        writeFileSync(resolve(output, file.slice('assets/'.length) + '.gz'), gzipSync(contents, { level: 9 }));
        delete bundle[file];
      }
      this.emitFile({ type: 'asset', fileName: 'optional-assets.json',
        source: JSON.stringify({ groups: Object.keys(groups), assets }) });
      this.info('Prepared ' + owners.size + ' downloadable assets for the ExtendownPlugin release.');
      },
    },
  };
}
