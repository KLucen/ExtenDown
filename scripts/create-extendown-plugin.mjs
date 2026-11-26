#!/usr/bin/env node
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { zipSync } from 'fflate';
import { PLUGIN_API_VERSION } from '../src/core/plugins/contracts.ts';
import {
  MAX_PLUGIN_MANIFEST_BYTES, MAX_PLUGIN_PACKAGE_BYTES, MAX_PLUGIN_SOURCE_BYTES,
} from '../src/core/plugins/plugin-archive.ts';
import { readScriptPlugin, validateScriptPlugin } from '../src/core/plugins/script-package.ts';

const sdkTypes = new URL('../sdk/extendown-plugin.d.ts', import.meta.url);

const usage = [
  'create-extendown-plugin init <目录> <插件 ID> [名称]',
  'create-extendown-plugin validate <目录或 .edplugin 文件>',
  'create-extendown-plugin pack <目录> [输出 .edplugin 文件]',
].join('\n');

function checkScript(source) {
  // Compile the script for syntax diagnostics without running it.
  new Script(source, { filename: 'plugin.js' });
}

async function readBounded(path, maximum) {
  const file = await open(path);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum) {
      throw new Error(path + ' 必须是普通文件，且不超过 ' + maximum / 1024 + ' KiB。');
    }
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (bytesRead === 0) return buffer.subarray(0, length);
      length += bytesRead;
    }
    throw new Error(path + ' 超过大小限制。');
  } finally {
    await file.close();
  }
}

async function readArchive(path) {
  if (extname(path).toLowerCase() !== '.edplugin') {
    throw new Error('插件包文件名须以 .edplugin 结尾。');
  }
  const plugin = readScriptPlugin(await readBounded(path, MAX_PLUGIN_PACKAGE_BYTES));
  checkScript(plugin.source);
  return plugin;
}

async function packProject(directory) {
  const [manifest, source] = await Promise.all([
    readBounded(join(directory, 'manifest.json'), MAX_PLUGIN_MANIFEST_BYTES),
    readBounded(join(directory, 'plugin.js'), MAX_PLUGIN_SOURCE_BYTES),
  ]);
  const bytes = zipSync({ 'manifest.json': manifest, 'plugin.js': source });
  const plugin = readScriptPlugin(bytes);
  checkScript(plugin.source);
  return { bytes, plugin };
}

async function init(directory, id, name = id) {
  const command = id + '.statistics';
  const manifest = {
    schemaVersion: 1,
    id,
    name,
    version: '1.0.0',
    hostApi: '^' + PLUGIN_API_VERSION,
    kind: 'command',
    entry: 'plugin.js',
    contributes: [command],
    permissions: ['document.read'],
    dependencies: {},
  };
  const source = [
    '// @ts-check',
    '',
    "/** @type {import('./extendown-plugin').PluginRun} */",
    'function run(input) {',
    '  if (input.command !== ' + JSON.stringify(command) + ') throw new Error("未知命令");',
    '  const document = input.document;',
    '  if (!document) return { message: "当前文档不可用。" };',
    '  let count = 0;',
    '  for (const _character of document.source) count++;',
    '  return { message: "字符数 " + count };',
    '}',
    '',
  ].join('\n');

  validateScriptPlugin({ manifest, source });
  checkScript(source);
  const types = await readFile(sdkTypes);
  // Create the target directory exclusively, so existing projects keep their files.
  await mkdir(directory);
  await Promise.all([
    writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }),
    writeFile(join(directory, 'plugin.js'), source, { flag: 'wx' }),
    writeFile(join(directory, 'extendown-plugin.d.ts'), types, { flag: 'wx' }),
  ]);
  console.log('已创建插件 ' + directory);
}

async function main(args) {
  const [action, target, idOrOutput, name] = args;
  if (args.length === 0 || (args.length === 1 && ['-h', '--help'].includes(action))) {
    console.log(usage);
    return;
  }
  if (action === 'init' && target && idOrOutput && args.length <= 4) {
    await init(resolve(target), idOrOutput, name);
    return;
  }
  if (action === 'validate' && target && args.length === 2) {
    const path = resolve(target);
    const plugin = (await stat(path)).isDirectory()
      ? (await packProject(path)).plugin
      : await readArchive(path);
    console.log('校验通过 ' + plugin.manifest.id + ' @ ' + plugin.manifest.version);
    return;
  }
  if (action === 'pack' && target && args.length <= 3) {
    const { bytes, plugin } = await packProject(resolve(target));
    const destination = resolve(idOrOutput ?? (plugin.manifest.id + '.edplugin'));
    if (extname(destination).toLowerCase() !== '.edplugin') {
      throw new Error('输出文件名须以 .edplugin 结尾。');
    }
    await writeFile(destination, bytes, { flag: 'wx' });
    console.log('已创建插件包 ' + destination);
    return;
  }
  throw new Error(usage);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
