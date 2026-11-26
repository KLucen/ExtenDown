# ExtenDown Tauri Markdown 编辑器接入指南

本指南说明 ExtenDown 如何复用 MerMarkd 的阅读器与源码编辑器组件。当前基线使用 Tauri v2、React、TypeScript、Vite 和 CodeMirror。源码、预览与分屏都从同一个 Markdown 草稿派生。P0 验收单窗口桌面壳和编辑界面，原生文档保存、多窗口及导出属于后续阶段。

## 1. 搭起第一个可运行版本

Windows 上需要 Node.js 22.12 或更新的受支持版本、Rust 的稳定版 MSVC 工具链、Visual Studio C++ Build Tools 和 Microsoft Edge WebView2 Runtime。安装 C++ 工具时选择“使用 C++ 的桌面开发”。先在新终端确认 `node --version` 和 `rustc --version` 都可运行。如果安装了 Rust，但 PowerShell 找不到 Cargo，可用下面的第一条命令仅给当前终端补齐搜索路径。环境安装说明以 [Tauri 官方前置条件](https://v2.tauri.app/start/prerequisites/#windows) 为准。

在解压目录运行：

```powershell
npm ci
npm test
npm run dev
```

打开 `http://127.0.0.1:1420/`。改动源码，确认预览同步更新，再切换源码、预览和分屏。打开本地文档后可以下载一份新副本，混合换行文档走保守的只读路径。用 UTF-8 BOM、CRLF、中文和 emoji 的文件检查打开与副本导出。

切到桌面时结束手动运行的 Vite，再执行：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run tauri -- info
npm run tauri -- dev
```

`vite.config.ts` 和 `src-tauri/tauri.conf.json` 对齐 `127.0.0.1:1420`，生产前端目录为 `../dist`。`strictPort` 会在端口占用时直接报错，避免桌面窗口连接到另一个开发服务。修改应用标识、标题或端口时，同时核对相应配置。[Tauri 的 Vite 配置](https://v2.tauri.app/start/frontend/vite/)

需要构建验证用的 Windows 可执行程序时执行 `npm run tauri -- build --no-bundle`。可执行程序位于 `src-tauri/target/release/` 下。面向其他机器发布时，再配置安装包图标、签名和 WebView2 分发方式，并在干净 Windows 验证安装与升级。[Tauri Windows 打包](https://v2.tauri.app/distribute/windows-installer/)

## 2. 按功能采用代码

| 需求 | 对应代码 | 接入要点 |
| --- | --- | --- |
| 预览 CommonMark、GFM、表格、列表和代码围栏 | `src/renderer/markdown-preview.tsx`、`reader-markdown.tsx`、`src/core/markdown-snapshot.ts`、`reading-render.ts` | 从 Markdown 缓冲区生成安全树，使用 React 渲染。预览不会保存或回写 Markdown。 |
| 源码编辑、光标和选区 | `src/renderer/source-surface.tsx` | 给每个打开的文档一个稳定的 `documentKey`。通过 `value` 和 `onChange` 接入草稿，用 `SourceSurfaceHandle` 聚焦或跳转。示例在独立的装配代码中添加 CodeMirror 历史。 |
| UTF-8、BOM 和换行 | `src/core/markdown-source.ts`、`editor-text.ts` | 打开时严格解码，保留文件格式元数据，给编辑器 LF 投影。导出时按原换行风格重建，再编码为字节。对混合换行不要偷偷统一格式。 |
| 目录、段落定位和可见文字查找 | `src/core/source-outline.ts`、`reader-navigation.ts`，以及阅读搜索模块 | 目录与定位结果绑定文档和修订版本。CodeMirror 偏移是 UTF-16，持久化字节偏移需要显式映射。 |
| 阅读态局部编辑 | `src/core/reader-edit.ts`、`selection-map.ts`、`src/renderer/reader-editable-block.tsx`、`reader-edit-session.ts` | 复用的是受限的文字跨度映射和组合输入处理。只有范围可精确定位时才修改 Markdown，映射失败时把内容交给源码编辑入口。 |

预览接口的最小用法：

```tsx
import { MarkdownPreview } from './renderer/markdown-preview';

export function PreviewPane({ draft }: { draft: string }) {
  return <MarkdownPreview source={draft} />;
}
```

源码编辑器的 `onChange` 是草稿更新入口。用户修改视图模式时，保留同一缓冲区和文档标识。切换到另一份文件时更新 `documentKey`，让旧文档的输入、选区和历史结束。如果将来让两种界面共同修改 Markdown，先确定唯一的撤销历史所有者。保留代码中的 IME 活动状态和收尾检查，防止候选拼音提前进入历史或触发保存。

阅读渲染保留 MerMarkd 的 HTML 白名单和清洗顺序。默认预览将外部链接和图片显示为受控内容。实现图片预览或打开外链时，让宿主单独校验协议和授权范围。对相对图片按当前文档目录解析，验证真实路径，并为允许的媒体返回受限资源。这个职责适合放在 Rust 侧，避免前端获得任意路径访问能力。[Tauri 权限与 capability](https://v2.tauri.app/security/capabilities/) · [Tauri 内容安全策略](https://v2.tauri.app/security/csp/)

## 3. 把浏览器副本演示接到原生文件生命周期

先在 Rust 实现单窗口、单文档。前端调用明确的业务命令，路径由用户通过原生对话框选定，再由 Rust 保存到当前文档会话。建议从以下合同开始：

| 命令 | 前端参数 | Rust 侧负责 |
| --- | --- | --- |
| `open_markdown` | 无 | 打开文件选择框，限制文件类型与可接受大小，读取严格 UTF-8 字节，保存路径、基线摘要和格式，返回文档标识、显示名称、源码及格式。取消时保留现有会话。 |
| `save_markdown` | `documentId`、草稿文本和单调递增 `revision` | 找到已授权路径，核对文档标识与修订，检查外部变更和当前保存状态。重建原格式，使用已验证的临时文件和发布策略写入，成功后更新基线。 |
| `save_markdown_as` | 草稿文本和 `revision` | 通过保存对话框选择新路径，确认覆盖语义，持久化成功后才切换当前文档身份。 |

使用 `#[tauri::command]` 注册这些操作，由 `@tauri-apps/api/core` 的 `invoke` 调用。当前骨架只装载前端，正式接入时再为命令、对话框或资源新增精确授权。用一个有类型的适配器集中 IPC，例如 `DocumentHost.open/save/saveAs`，这样浏览器和桌面可以共用界面与测试夹具。[前端调用 Rust](https://v2.tauri.app/develop/calling-rust/) · [Tauri 对话框](https://v2.tauri.app/plugin/dialog/)

启用 IPC 时将 `@tauri-apps/api` 加入 `package.json` 和锁文件，按 Tauri 的开发、生产协议配置 `connect-src`，并保持远程页面没有桌面权限。骨架默认的生产配置为 `connect-src 'none'`，这是当前仅加载前端的设置。最小验证从原生对话框打开一份合成夹具，再到保存冲突；不要先开放通用文件写入命令。

保存先做下面的闭环。Rust 记录打开时的源字节摘要。显式保存请求到达时重新读取目标，若已被外部编辑则显示冲突并提供重新载入或另存。保存候选先写同目录临时文件并同步，替换失败时保留恢复所需文件。Windows 上要用实际落盘测试验证目标已存在、只读目录、外部写入竞争和中断恢复；仅比较摘要后直接 `fs::write` 容易在失败时截断原件。保存完毕再更新基线，并给仍在编辑的较新修订保留未保存状态。文件打开、窗口关闭和退出都通过同一套未保存输入检查。

首轮至少核对这些行为：显式保存或另存之前源文件字节不变。原始 BOM、换行风格和尾换行在无修改时精确往返。拒绝非法 UTF-8 和不支持的混合换行写入。外部修改不被静默覆盖。真实中文输入法确认、取消、失焦与保存互不干扰。

## 4. 逐步实现接近 Typora 的编辑体验

1. **先完成独立文件编辑闭环。** 打开、源码编辑、预览、保存、另存、关闭和恢复都能在 Tauri 打包版运行。把文件权限、历史和恢复问题解决在这一步。
2. **做一小块排版内编辑。** 从普通段落和标题开始，让激活的块显示可编辑内容。每次改动通过源范围更新 Markdown，并用解析结果验证改动后的语义。表格、链接、跨格式粘贴和列表嵌套逐类开放。
3. **再优化所见即所得。** 在源码引擎上做局部语法显示，或另选结构化编辑器。结构化编辑器需要为 Markdown 方言、注释、空白和原始 HTML 定义往返规则。当前预览在 UI 线程解析，分屏示例用延迟值减少输入阻塞。面向大文档时，把预览投影计算移到 Web Worker，并根据文档标识和修订丢弃过期结果；上线前测量真实 IME、撤销后光标、可编辑标题的辅助名称、大文档查找和多屏 DPI。

一个实用验收样本是在同一份含 BOM、CRLF、中文、emoji、表格、嵌套列表、链接和代码围栏的文档中，分别完成打开、跨视图撤销、显式保存、外改冲突与重启恢复。实现复杂排版编辑前先固定这些文件级保证，后续功能才能共用已有验证。
