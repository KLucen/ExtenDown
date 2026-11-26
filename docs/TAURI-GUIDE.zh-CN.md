# ExtenDown Tauri Markdown 编辑器接入指南

ExtenDown 使用 Tauri v2、React、TypeScript、Vite 和 CodeMirror，复用 MerMarkd 的源码编辑与阅读组件。源码、并排和预览共享 Markdown 草稿和撤销历史。具体复用范围见 [来源清单](../PROVENANCE.md)。

## 启动与打包

在仓库根目录运行 `npm ci` 安装锁定的前端依赖。`npm run dev` 启动 `http://127.0.0.1:1420/`。浏览器使用文件选择器读取 UTF-8 文档，保存时下载副本。桌面开发命令会自行启动 Vite，运行前先结束占用这个端口的开发服务器。

Windows 需要 Node.js 22.12 或更新版本、Rust stable MSVC、Visual Studio C++ Build Tools 和 WebView2 Runtime。安装 C++ 工具时选择「使用 C++ 的桌面开发」。如果 `cargo` 已在 PATH 中，可略过环境变量这一行。[Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri -- info
npm run tauri -- dev
```

```powershell
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --no-bundle -- --locked
npm run tauri -- build --bundles nsis -- --locked
```

`vite.config.ts` 与 `src-tauri/tauri.conf.json` 共享开发地址。Vite 使用 `strictPort`，生产应用从 `dist/` 加载内嵌资源。独立可执行程序位于 `src-tauri/target/release/`。Windows 安装器位于该目录下的 `bundle/nsis/`，Windows 专用配置见 `src-tauri/tauri.windows.conf.json`。[Tauri 的 Vite 配置](https://v2.tauri.app/start/frontend/vite/) · [Windows 打包](https://v2.tauri.app/distribute/windows-installer/)

Windows 便携版本由 `extendown.exe` 和同目录的 `extendown-components/` 组成，可一起复制。用 NSIS 安装时，安装器根据组件页的选择复制官方扩展，核心编辑器和原生文件服务始终安装。

Windows 当前用户默认安装到 `%LOCALAPPDATA%\extendown\app`。安装向导可更改目标目录，命令行也支持显式的 `/D=` 路径。升级时沿用仍有有效卸载登记的安装目录。卸载时移除该目录对应的安装路径记录。

每轮开发验收后，从 `bundle/nsis/` 运行新版本安装包覆盖更新。向导默认保留当前安装，组件页沿用旧版已安装组件。自动化覆盖更新可在关闭 ExtenDown 后运行 `ExtenDown_<版本>_x64-setup.exe /S /UPDATE`。

## 窗口与文档

顶栏集中提供文件、查找、目录、专注、导出和设置。左侧的源码、并排和预览按钮切换编辑布局，顶栏左端的按钮负责收起或展开整个侧栏。Windows 桌面版将窗口操作放在同一顶栏右端。

「文件 → 打开文件」或 `Ctrl+O` 使用系统文件选择器打开 `.md`、`.markdown` 或 `.txt`。桌面版支持拖放打开。窗口可通过「文件 → 新建窗口」独立创建，宿主按规范化路径查找现有会话。再次打开已载入的文档时会激活其窗口。

「文件 → 保存」或 `Ctrl+S` 写入当前文档，新文档会打开另存对话框。首次读入时校验 UTF-8，支持 BOM 和 LF、CRLF、CR。混合换行文档保持只读，可另存原样副本。桌面和浏览器入口的单文档上限为 2 MiB。只有显式保存时才写入源文件，自动保存的恢复草稿放在应用数据目录下。

Rust 宿主将文档 ID 绑定到发起操作的窗口，保存时检查修订号和原始文件的 SHA-256，并在发布临时文件前复核磁盘状态。如果外部程序已改动原件，界面提供「重新载入」和「另存为」。关闭或切换带修改的文档时，可以确认保留草稿。重开应用后从「文件 → 恢复草稿」载入。如果磁盘内容已经改变，恢复的草稿作为待另存的新文档打开。

### `.md` 默认应用

Windows 的 NSIS 安装器通过 `src-tauri/windows/file-associations.nsh` 注册 ExtenDown 的打开命令和可处理的 `.md`、`.markdown` 类型。安装后，从「设置 → 常规 → 选择 .md 默认应用」进入 Windows 默认应用面板，查找 `.md` 并选择 ExtenDown。`.markdown` 可以在同一面板单独配置。双击关联文件后，文件路径由系统传给桌面应用，再转交已有的 ExtenDown 进程或新开的窗口。

## 复用与插件接口

| 入口 | 职责 |
| --- | --- |
| `src/renderer/source-surface.tsx` | CodeMirror、选区、导航、软换行和输入法组合输入 |
| `src/renderer/markdown-preview.tsx` | Markdown 排版阅读、章节定位、受控相对图片 |
| `src/core/preview-projection.ts` | 从快照生成安全 HAST、标题锚点和可用扩展的呈现结果 |
| `src/core/plugins/` | Manifest、主题令牌、扩展注册与注销、主题包加载 |
| `src/demo/document-session.ts` | 前端缓冲区、文档修订和桌面 IPC 装配 |
| `src-tauri/src/document.rs`、`recovery.rs` | 窗口文档会话、文件保存与草稿恢复 |

标题锚点、选区、目录和预览都来自当时的文档草稿。保留同一个 `documentKey` 以维持视图间的撤销历史，并在打开另一份文档时重建编辑器会话。输入法候选期间，保存和切换文档等待组合输入结束。原始 HTML 经现有白名单和清洗流程，公式和高亮由已验证的内置转换器生成。相对图片由 Rust 在文档目录范围内解析、检查文件类型和读取大小。[Tauri 权限](https://v2.tauri.app/security/capabilities/) · [内容安全策略](https://v2.tauri.app/security/csp/)

首次启动直接进入编辑器。预览及并排中的普通段落、标题可单击编辑，键盘可聚焦后按 Enter。数学扩展支持 `$…$` 和 `$$` 公式，可离线渲染为 MathML。Mermaid 从 `mermaid` 围栏生成图像，关闭模块或排版失败时保留代码块。高亮支持 Bash、CSS、JavaScript、JSON、Python、Rust、SQL、TypeScript 与 XML/HTML。

Windows 安装器的组件页提供 HTML、PDF、PNG/JPG、数学公式、Mermaid、专注视图、额外代码语言和 Midnight 主题。额外语言包提供 C、C++、C#、Go、Java、Lua、Markdown 和 PowerShell。「设置 → 插件」展示全部官方组件，已安装组件可启停，未安装组件可离线补装。PNG 和 JPG 共用一套安装资源，可在安装后分别启停。

### 官方模块

在 `src/core/plugins/builtin.ts` 声明 `PluginModule`。每个模块的 Manifest 填写 `schemaVersion`、独立 `id`、版本、`hostApi`、`kind`、`entry`、贡献 ID、权限和依赖。当前宿主 API 为 `1.0.0`。`activate(registry)` 使用 `registry.register(kind, contribution)` 注册贡献。每次注册返回 `Disposable`，插件停用时由注册表释放。激活函数也可以返回清理资源的函数。

1. 把新增模块接入 `src/demo/settings.tsx` 的启用选项。注册表验证 Manifest、依赖和贡献 ID，模块激活后才进入可用功能列表。
2. 在功能宿主消费贡献。语法模块在安全 Markdown 投影后接入渲染，视图模块由编辑器消费，导出器在 `src/core/export/` 读取只读文档快照。新的导出格式同时声明输出文件后缀和保存规则。
3. 在 `tests/core/plugins.test.ts` 覆盖激活、停用和兼容性，在相应功能入口验证贡献生效。文件、窗口和对话框通过固定的 Tauri 命令实现，原生改动随应用编译发布。

若模块需要独立安装，在 `scripts/optional-components.mjs` 登记动态入口，并将组件 ID 接入 `src-tauri/windows/components.nsh`。Windows 构建从内嵌资源中移出该入口的专用代码，NSIS 根据组件选择复制文件。Rust 宿主只从本版内置的资源清单中查找这些文件，并在加载前核对 SHA-256。两个组件共用的导出渲染资源随任一需要它的组件安装。

Windows 安装器在 `extendown-components/available/` 放置压缩的官方组件资源。补装时，Rust 按当前版本的内置清单校验并恢复资源，写入所选组件，再向各窗口广播更新。「安装插件文件」用于导入数据型主题和命令插件包。

### 主题包

主题包是扩展名为 `.edplugin` 的 ZIP。根目录放置 UTF-8 编码的 `manifest.json` 和 `theme.json`，可以附带 `preview.png`。存档最大 512 KiB，两个 JSON 文件各最大 16 KiB。主题可仅声明要覆盖的令牌，其余使用默认值。用户包以 JSON 令牌描述颜色、字体和阅读宽度，权限和依赖均留空。

`manifest.json`

```json
{
  "schemaVersion": 1,
  "id": "org.example.aurora",
  "name": "Aurora",
  "version": "1.0.0",
  "hostApi": "^1.0.0",
  "kind": "theme",
  "entry": "theme.json",
  "contributes": ["theme:aurora"],
  "permissions": [],
  "dependencies": {}
}
```

`theme.json`

```json
{
  "schemaVersion": 1,
  "tokens": {
    "surface": "#eef7f3",
    "text": "#203029",
    "readingWidth": "68ch"
  }
}
```

在「设置 → 插件」选择「安装插件文件」，再用「设置 → 常规 → 外观」切换。插件列表可停用或卸载本地主题。安装状态与启用设置保存在当前应用的本地配置中。

## 导出

顶栏的「导出」使用点击时的草稿快照。选择格式，检查预览，再通过系统保存对话框选定目标。浏览器版用下载代替保存对话框。

| 格式 | 效果与限制 |
| --- | --- |
| HTML | 单文件离线 HTML。内嵌样式、Mermaid 图表和获准读取的相对图片。无法加载的图片保留文字提示。 |
| PDF | 图像分页，可选 A4 或 Letter、方向、页边距和清晰度。页面文字随图像保存，需要原文文本时用 HTML 输出。最多 100 页。 |
| PNG、JPG | 可选单张图像或分段图片 ZIP，支持 1× 或 2×。单张图像限制单边 16,384 像素、总面积 2,200 万像素。 |

PDF、PNG 和 JPG 先在独立页面完成排版，再按所选格式渲染。长文档可在 PNG 或 JPG 的导出设置选中「分段图片（ZIP）」。导出文件最大 64 MiB，达到上限时界面显示错误。可复测的用例和平台范围见 [验收记录](VERIFICATION.zh-CN.md)。
