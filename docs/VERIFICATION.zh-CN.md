# 本机验收记录

2026-11-26 在 Windows x64 验证。前端使用 Node.js 24.20.0、npm 11.19.0、Vite 7.3.6。桌面使用 Rust/Cargo 1.99.1、MSVC Build Tools 2022、Tauri 2.12.5、Tauri CLI 2.12.6 和 WebView2 158.0.4370.33。

| 验证项 | 结果 |
| --- | --- |
| `npm test` | 51 项通过。涵盖严格 UTF-8、BOM 和换行、局部编辑映射、组合输入会话和 Markdown 清洗。 |
| `npm run build` | TypeScript 及 Vite 生产构建通过。单个主脚本约 874 kB，Vite 提示后续可以按功能拆包。 |
| 在 Edge 中运行生产前端 | 打开测试 Markdown，验证 GFM 表格与任务列表、锚点跳转、外链和图片限制、三视图、撤销与重做、拒绝无效 UTF-8、未保存时取消打开，以及 BOM、CRLF 和混合换行的精确副本。 |
| Tauri Rust 构建 | `cargo check --locked --offline` 和嵌入 Vite `dist` 的 `cargo build --locked --offline --features custom-protocol` 均通过。 |
| 在 Windows WebView2 中运行嵌入版 | 在 `http://tauri.localhost/` 启动嵌入资源，导入 UTF-8 夹具，编辑后更新预览，切换视图并撤销。使用隔离 WebView 配置，完成后关闭测试进程。 |

WebView2 测试通过自动化文件输入和按键完成，真实中文输入法、桌面进程关闭时的草稿恢复、原生覆盖保存、安装器和签名发布留给新项目验收。演示中的原始下载字节核对使用 Edge，Tauri 宿主提供前端运行环境。
