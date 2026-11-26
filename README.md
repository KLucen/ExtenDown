# Markdown Editor · Tauri 复用包

这是从 MerMarkd 提取的 Markdown 阅读与源码编辑起点。示例提供源码、预览和分屏三种显示方式，各视图共用同一份 Markdown 缓冲区。复用范围限阅读和编辑，卡片、画布、批注侧车和 Electron 外壳均未纳入。代码位于 `src/`，接入步骤和后续开发顺序见 [Tauri 接入指南](docs/TAURI-GUIDE.zh-CN.md)。

## 先在浏览器体验

使用 Node.js 22.12 或更新的受支持版本。解压后在本目录运行：

```powershell
npm ci
npm run dev
```

浏览器打开 `http://127.0.0.1:1420/`。可以试改内置文档，也可以打开本地 UTF-8 Markdown，编辑后显式下载副本。

## 启动 Tauri 桌面窗口

Windows 需要 Rust、Visual Studio C++ Build Tools 和 Edge WebView2。安装好环境并重新打开终端后运行：

```powershell
npm run tauri -- info
npm run tauri -- dev
```

如果之前手动启动了 `npm run dev`，先结束那个进程，让 Tauri 自己启动前端。示例使用 Tauri v2，源码可按文件移植到新项目。桌面原生保存、文件引用授权和所见即所得编辑方案见指南。

```powershell
npm test
npm run build
npm run tauri -- build --no-bundle
```

## 复用入口

| 文件 | 用途 |
| --- | --- |
| `src/renderer/source-surface.tsx` | CodeMirror 源码编辑表面、选区控制、软换行和组合输入状态 |
| `src/renderer/markdown-preview.tsx` | 独立只读预览入口 |
| `src/core/` | Markdown 解析与安全渲染、目录、编码及换行工具、可映射编辑逻辑 |
| `src/demo/` | 把阅读和编辑接到同一缓冲区的示例 |
| `src-tauri/` | 接入同一套前端的 Tauri v2 桌面宿主 |

本机通过了 51 项单测、生产前端构建、Edge 浏览器交互与 Windows WebView2 桌面启动验证。验证范围见 [验收记录](docs/VERIFICATION.zh-CN.md)，原始文件与适配代码见 [来源清单](PROVENANCE.md)。本包沿用原仓库的 `UNLICENSED` 标记，供该项目所有者继续开发。
