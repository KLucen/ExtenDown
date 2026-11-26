# ExtenDown

ExtenDown 是基于 Tauri v2 的本地 Markdown 编辑器。左侧可折叠侧栏只放「源码」「并排」「预览」。顶栏集中提供文件、查找、目录、专注、导出和设置，Windows 窗口按钮位于右端。

## 使用

- 从「文件」新建文档或窗口，打开 `.md`、`.markdown`、`.txt`，保存或另存为。桌面版也可直接拖入文件。同一路径已打开时，应用切换到现有窗口。
- 从「文件 → 最近打开」返回已有文档，从「文件 → 恢复草稿」找回未保存的内容。目标文件被外部修改时，可以从磁盘重新载入或另存当前草稿。
- 预览支持 CommonMark、GFM 表格和任务列表、常见语言的围栏代码高亮、授权范围内的相对图片，以及可选的数学公式和 Mermaid 图表。
- 在「设置 → 插件」按需启停已安装的扩展，或用「安装插件文件」加载数据型 `.edplugin` 主题包，再到「设置 → 常规 → 外观」选择主题。
- 同一入口可安装第三方命令插件。核对权限并启用版本后，从顶栏「命令」运行。审阅并应用的文档变更进入撤销历史。[命令插件开发指南](docs/PLUGIN-DEVELOPMENT.zh-CN.md)
- 从顶栏「导出」生成 HTML、PDF、PNG 或 JPG。HTML 可离线打开，PDF 以图像分页，PNG 和 JPG 可输出单张图或分段图片 ZIP。

Windows 的 NSIS 安装器可选择安装官方导出、语法、视图、语言和主题扩展，并将 ExtenDown 注册为 `.md` 和 `.markdown` 的候选应用。安装后，在「设置 → 常规 → 选择 .md 默认应用」打开 Windows 系统设置，再按扩展名选择 ExtenDown。

## 开发与构建

前端需要 Node.js 22.12 或更新版本。Windows 桌面开发还需要 Rust stable MSVC、Visual Studio C++ Build Tools 和 WebView2 Runtime。其他平台的系统依赖见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。

```powershell
npm ci
npm run dev
```

浏览器入口为 `http://127.0.0.1:1420/`。浏览器版通过文件选择器读取文档并下载副本。结束单独运行的 Vite 后，再启动桌面开发版。若当前 PowerShell 已能运行 `cargo`，可略过第一行。

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

最后两条命令分别生成便携桌面程序和 Windows NSIS 安装器，产物位于 `src-tauri/target/release/` 及其 `bundle/nsis/` 子目录。复制便携版时将 `extendown.exe` 与 `extendown-components/` 放在同一目录。文件关联注册由 NSIS 安装器处理。

桌面接入和主题包格式见 [Tauri 接入指南](docs/TAURI-GUIDE.zh-CN.md)。测试范围和环境见 [验收记录](docs/VERIFICATION.zh-CN.md)。产品路线和复用来源见 [首版设计方案](docs/INITIAL_DESIGN.zh-CN.md) 与 [来源清单](PROVENANCE.md)。
