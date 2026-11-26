# ExtenDown

ExtenDown 是基于 Tauri v2 的本地 Markdown 编辑器。P0 基线复用 MerMarkd 的源码编辑和安全阅读组件，提供源码、预览和分屏三种视图，并让它们共用同一份 Markdown 草稿。

当前版本用于验收编辑界面与桌面宿主启动。原生文件保存、多窗口、代码高亮和 PDF/HTML/PNG/JPG 导出仍按 [首版设计方案](docs/INITIAL_DESIGN.zh-CN.md) 后续阶段开发。组件来源和复用范围见 [来源清单](PROVENANCE.md)。

## 环境

浏览器开发需要 Node.js 22.12 或更新版本。Windows 桌面开发还需要 Rust stable MSVC、Visual Studio C++ Build Tools 和 WebView2 Runtime。

在仓库根目录安装依赖并启动开发服务。

```powershell
npm ci
npm test
npm run dev
```

在浏览器打开 `http://127.0.0.1:1420/`。应用会载入内置示例文档。在源码区输入 Markdown，检查分屏预览是否更新，再切换源码、预览和分屏。可通过“打开文件”载入本地 Markdown，并用“下载副本”保存编辑结果。

运行以下命令启动 Windows 桌面窗口。若当前终端可以运行 `cargo`，可略过第一行。

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri -- info
npm run tauri -- dev
```

若已手动运行 `npm run dev`，请先结束它。Tauri 会自行启动 Vite。macOS 和 Linux 使用同一组 npm 命令，系统依赖见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。

## P0 验收

```powershell
npm test
npm run build
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri -- build --no-bundle -- --locked
```

当前 Windows 验收记录见 [P0 验收记录](docs/VERIFICATION.zh-CN.md)。Vite 与 Tauri 前端配置固定使用 `127.0.0.1:1420`。项目版本、依赖与应用标识集中在 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json`。

## 复用入口

| 文件 | 用途 |
| --- | --- |
| `src/renderer/source-surface.tsx` | CodeMirror 源码编辑器、选区、导航、软换行和输入法组合输入 |
| `src/renderer/markdown-preview.tsx` | CommonMark/GFM 安全预览 |
| `src/core/` | Markdown 投影、章节导航、源码映射、UTF-8/BOM/换行和安全清洗 |
| `src/demo/main.tsx` | P0 源码、预览和分屏共享缓冲区装配 |
| `src-tauri/` | Tauri v2 桌面宿主 |

首版产品范围、插件边界和开发阶段见 [首版设计方案](docs/INITIAL_DESIGN.zh-CN.md)。桌面接入细节见 [Tauri 接入指南](docs/TAURI-GUIDE.zh-CN.md)。
