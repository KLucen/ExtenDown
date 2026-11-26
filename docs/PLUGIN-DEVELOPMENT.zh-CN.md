# ExtenDown 命令插件开发

命令插件通过 `.edplugin` 文件安装。启用某个版本后，用户可从顶栏「命令」运行其贡献。每次运行都在独立的 JavaScript 环境中执行。宿主按权限给插件提供当前文档快照，并负责审阅和应用插件提出的变更。

## 创建、校验与打包

准备 Node.js 22.12 或更新版本。在 ExtenDown 仓库根目录运行以下命令。

```powershell
npm ci
node --experimental-strip-types scripts/create-extendown-plugin.mjs init ./word-count org.example.word-count 字符统计
node --experimental-strip-types scripts/create-extendown-plugin.mjs validate ./word-count
node --experimental-strip-types scripts/create-extendown-plugin.mjs pack ./word-count ./word-count.edplugin
node --experimental-strip-types scripts/create-extendown-plugin.mjs validate ./word-count.edplugin
```

脚手架创建 `manifest.json`、`plugin.js` 和编辑器使用的 `extendown-plugin.d.ts`。校验器使用应用的包规则，并编译检查 JavaScript 语法。插件运行效果和返回数据应在应用中验证。工作目录和输出文件需使用新路径。

仓库中的示例同时提供字符统计和文末换行两个命令。可直接打包体验。 [示例清单](../examples/plugin-markdown-tools/manifest.json) · [示例代码](../examples/plugin-markdown-tools/plugin.js) · [SDK 类型](../sdk/extendown-plugin.d.ts)

```powershell
node --experimental-strip-types scripts/create-extendown-plugin.mjs pack ./examples/plugin-markdown-tools ./markdown-tools.edplugin
```

## 编写清单

每个脚本包使用 ZIP 格式和 `.edplugin` 扩展名，根目录包含 UTF-8 编码的 `manifest.json` 与 `plugin.js`。清单上限为 16 KiB，入口脚本上限为 128 KiB，完整包上限为 512 KiB。项目中的类型文件和构建配置留在项目目录。

```json
{
  "schemaVersion": 1,
  "id": "org.example.word-count",
  "name": "字符统计",
  "version": "1.0.0",
  "hostApi": "^1.0.0",
  "kind": "command",
  "entry": "plugin.js",
  "contributes": ["org.example.word-count.statistics"],
  "permissions": ["document.read"],
  "dependencies": {}
}
```

- 用自己的命名空间声明 `id`。每个贡献使用插件 ID 或以插件 ID 加一个点开头的命令 ID。`contributes` 可声明 1–20 个不重复的命令。
- `version` 使用稳定版 `major.minor.patch`。`hostApi` 支持精确版本和 `^` 范围，当前宿主 API 版本为 `1.0.0`。
- `permissions` 可为空。申请 `document.read` 后，运行时可收到当前窗口的文档文本与修订号。提议替换 Markdown 源码需要同时声明 `document.read` 与 `document.transform`。
- 这个版本支持 `command` 贡献和空 `dependencies`。应用会拒绝声明文件、网络、窗口或导出权限的脚本包。

## 编写命令

在 `plugin.js` 声明同步全局函数 `run(input)`。`input.command` 是被执行的贡献 ID。获得读取权限时，可通过 `input.document` 读取 `source` 和 `revision`。`input.document` 是可选字段。

```js
// @ts-check

/** @type {import('./extendown-plugin').PluginRun} */
function run(input) {
  if (input.command !== 'org.example.word-count.statistics') {
    throw new Error('未知命令');
  }
  const document = input.document;
  if (!document) return { message: '当前文档不可用。' };
  let count = 0;
  for (const _character of document.source) count++;
  return { message: '字符数 ' + count };
}
```

`run` 返回可序列化对象，至少含一个字段。`message` 是显示给用户的纯文本，上限为 2,048 个 UTF-16 代码单元。`source` 是整份 Markdown 的候选替换文本，使用 LF 换行，由宿主在保存时恢复原有换行和 BOM。宿主确认当前修订仍与命令运行时一致后，才接受用户确认的替换。第三方脚本运行时提供标准的 JavaScript 语言环境。将用到的库编译进同一份 `plugin.js`，以全局脚本形式输出。

## 安装与版本管理

1. 在「设置 → 插件」点击「安装插件文件」，选择 `.edplugin`。
2. 在「第三方命令插件」中点击「启用」，核对该版本请求的权限并确认。
3. 从顶栏「命令」选择命令并点击「运行」。返回 `source` 时，在「审阅文档变更」确认并点击「应用变更」。
4. 更新时保留同一个 ID，提高 `version`，然后安装新版包。应用保留上一个版本，可在插件行选择「回滚」。更新和回滚后均需为该版本确认权限并重新启用。

主题 `.edplugin` 继续使用原有主题格式，可通过同一入口安装。 [主题包格式](TAURI-GUIDE.zh-CN.md#主题包)
