# ExtenDown 验收记录

## P4 第三方命令插件

84 项前端测试、8 项 Rust 测试和 TypeScript 检查通过。Windows 组件模式完成前端生产构建和 Tauri 可执行程序编译。

- Edge 实测从设置安装和授权插件，运行 Unicode 字符统计，审阅并应用文末换行，然后通过撤销恢复原文。
- Windows WebView2 生产版实测安装、启用、中文及 emoji 文档变换、审阅、撤销、更新、回滚和无权限命令。
- 手动更新与回滚均重置授权。验证了同 ID 并发安装、跨窗口停用、过期授权拒绝和回滚冲突。
- 无权限的脚本无法看到当前文档，执行环境未提供网络、浏览器 DOM、文件或 Tauri API。自动化测试覆盖内存和输出限制，Edge 验证超时、取消和下一条命令独立运行。
- 「命令」面板显示本窗口最近 20 次运行的命令、版本和结果。
- 脚手架实测通过创建、目录校验、打包和归档校验。语法错误、未支持权限和覆盖已有输出请求会返回错误。[命令插件开发指南](PLUGIN-DEVELOPMENT.zh-CN.md)

## P1–P3 桌面版

在 Windows x64 和 Edge 中验收，桌面用例使用安装器或生产版 `extendown.exe`。文档、插件和导出文件使用独立测试夹具。

| 验收项 | 结果 |
| --- | --- |
| 顶栏和侧栏 | 顶栏集中操作，左侧依次为源码、并排和预览。验证收起、展开、切换预览和隐藏源码区。 |
| 原生文档读写 | 打开含中文、emoji、BOM、CRLF、GFM 表格和相对图片的文件。用 `Ctrl+S` 保存后字节仍保留 BOM 与 CRLF。外部追加内容后再次保存触发冲突，磁盘上的外部追加内容保留。 |
| 多窗口和草稿 | 命令行向已有进程传入第二份文档，创建独立窗口。再传入同一绝对路径后，窗口 ID 和数量一致。关闭第一个有改动的窗口时确认保留草稿，第二个窗口继续运行。通过文件菜单恢复草稿并在原生对话框另存，副本含草稿标记并保留 BOM 与 CRLF。源文件摘要一致，成功另存后恢复草稿清除。 |
| Windows 文件关联 | 隔离目录安装、卸载均完成。检查了 `.md`、`.markdown` 候选注册与包含双引号的打开命令。安装和卸载前后两个扩展名的默认关联和 `UserChoice` 值一致。设置按钮打开了 Windows「应用 → 默认应用」页面。 |
| 本地主题安装 | 从系统文件对话框选择 `.edplugin`，Aurora QA 主题安装后应用于当前窗口。注册表单测覆盖 API 版本、依赖、重复贡献与停用清理。 |
| Markdown 扩展 | Edge 输出了 MathML 和常见语言代码高亮，离线生成了可解码的中文 Mermaid 流程图与时序图。额外代码语言单测验证启用时 Go 围栏高亮，停用时保留普通代码块。 |
| 桌面导出 | Windows WebView2 通过系统对话框保存 HTML、PDF、PNG 和 JPG。HTML 包含内嵌相对图片、数学公式和代码高亮。A4 PDF 可读取，PNG 和 JPG 可解码为 1800 × 1356。 |
| 长文档导出 | Chromium 生成了 4 页 A4 PDF，验证了 116 行高亮代码的分页、长行换行和最后的标题。独立 HTML 与分页 PDF 均包含 Mermaid 图表。分别解包 PNG 和 JPG 分段 ZIP，确认各有 3 张按顺序编号的有效图像。 |
| 可选安装 | NSIS 组件页显示八项可勾选扩展。全组件安装包含 67 个独立资源，逐个核对 SHA-256。打开已安装版，确认 Mermaid、公式、Go 高亮，以及 PDF 组件的原生保存流程。单独运行省略组件目录的可执行文件，文件打开、基本预览和三种视图仍可使用。 |
| 构建与自动化 | 72 项前端测试、8 项锁定依赖的 Rust 测试、TypeScript 检查与 Windows NSIS 生产构建通过。 |

PDF 使用分页图像，正文文字随图像输出。NSIS 组件页使用英文。macOS、Linux 和实际中文输入法仍需实机验收。

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

该阶段的 Windows 安装器与原生文件用例见上方 P1–P3 验收。macOS、Linux 和真实中文输入法待实机验收。

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
