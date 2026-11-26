# ExtenDown 验收记录

## P0 基线

2026-11-26 在 Windows x64 验收。环境为 Node.js 24.20.0、npm 11.19.0、Rust/Cargo 1.99.1、Visual Studio C++ Build Tools 2022、Tauri 2.12.5、Tauri CLI 2.12.6 与 WebView2 158.0.4370.33。

| 验收项 | 结果 |
| --- | --- |
| 项目标识与依赖锁 | 浏览器页面与 Windows 窗口均显示 ExtenDown。Tauri 应用标识为 `com.klucen.extendown`。`npm ci` 成功，`cargo check --locked --offline` 通过。|
| 前端单测与生产构建 | `npm test` 通过 51 项。`npm run build` 的 TypeScript 检查及 Vite 生产构建通过。Vite 对约 874 kB 的前端主脚本给出体积提示。|
| 浏览器开发环境 | 在 `http://127.0.0.1:1420/` 打开内置示例，确认 GFM 表格、任务列表与围栏代码块渲染。编辑标题后，分屏预览同步更新。切换到预览、源码，再撤销并回到分屏，两侧恢复到原文。|
| Windows WebView2 开发环境 | `npm run tauri -- dev` 启动 ExtenDown 窗口。窗口内复测源码、预览、分屏、草稿保留和跨视图撤销。Vite 已忽略 `src-tauri/`，避免监听 Rust 编译产物触发 Windows 的 `EBUSY` 文件锁错误。|
| Windows WebView2 生产环境 | `npm run tauri -- build --no-bundle -- --locked` 成功。在 Vite 停止后启动 `src-tauri/target/release/extendown.exe`，从 `http://tauri.localhost/` 加载内嵌页面，并显示源码、预览、表格与代码块。|

复测时先启动浏览器或桌面开发模式，打开内置示例，在分屏中改动一个 Markdown 标题。确认排版结果随之更新，切换到预览和源码，随后聚焦源码执行 `Ctrl+Z`，再回到分屏核对两侧内容。详细启动命令见 [README](../README.md)。

macOS 和 Linux 的桌面运行、Windows 安装器及真实中文输入法待实机验收。

## MerMarkd 复用包验证

2026-11-26 在 Windows x64 验证。前端使用 Node.js 24.20.0、npm 11.19.0、Vite 7.3.6。桌面使用 Rust/Cargo 1.99.1、MSVC Build Tools 2022、Tauri 2.12.5、Tauri CLI 2.12.6 和 WebView2 158.0.4370.33。

| 验证项 | 结果 |
| --- | --- |
| `npm test` | 51 项通过。涵盖严格 UTF-8、BOM 和换行、局部编辑映射、组合输入会话和 Markdown 清洗。 |
| `npm run build` | TypeScript 及 Vite 生产构建通过。单个主脚本约 874 kB，Vite 提示后续可以按功能拆包。 |
| 在 Edge 中运行生产前端 | 打开测试 Markdown，验证 GFM 表格与任务列表、锚点跳转、外链和图片限制、三视图、撤销与重做、拒绝无效 UTF-8、未保存时取消打开，以及 BOM、CRLF 和混合换行的精确副本。 |
| Tauri Rust 构建 | `cargo check --locked --offline` 和嵌入 Vite `dist` 的 `cargo build --locked --offline --features custom-protocol` 均通过。 |
| 在 Windows WebView2 中运行嵌入版 | 在 `http://tauri.localhost/` 启动嵌入资源，导入 UTF-8 夹具，编辑后更新预览，切换视图并撤销。使用隔离 WebView 配置，完成后关闭测试进程。 |

WebView2 测试通过自动化文件输入和按键完成，真实中文输入法、桌面进程关闭时的草稿恢复、原生覆盖保存、安装器和签名发布留给新项目验收。演示中的原始下载字节核对使用 Edge，Tauri 宿主提供前端运行环境。
