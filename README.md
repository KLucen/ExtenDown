# ExtenDown

ExtenDown 是基于 Tauri v2 的本地 Markdown 编辑器。左侧可折叠侧栏只放「源码」「并排」「预览」。顶栏集中提供文件、查找、目录、专注、导出和设置，Windows 窗口按钮位于右端。

## 使用

- 从「文件」新建文档或窗口，打开 `.md`、`.markdown`、`.txt`，保存或另存为。桌面版也可直接拖入文件。同一路径已打开时，应用切换到现有窗口。
- 从「文件 → 最近打开」返回已有文档。桌面版关闭有未保存修改的窗口时，可取消、丢弃或关闭并保留草稿。在「设置 → 草稿」可恢复或移除草稿，「文件 → 恢复草稿」提供快捷入口。
- 文档显示「混合换行 · 只读」时，点「转换并编辑」，选择 LF 或 CRLF。转换会生成可编辑的草稿，按「保存」时才修改磁盘上的原文件。
- 从桌面顶栏「工作区」选择本地文件夹。文件树按展开层级加载，可查找已保存的文件内容、检查相对链接，以及从文件行菜单新建、重命名或移到回收站。
- 桌面版的「设置 → 常规 → 版本与更新」显示当前版本。点击「检查更新」查询 GitHub 的正式发布，发现新版时可打开发布页。没有适用安装包时，界面会显示提示。
- 工作区打开文件夹后会在「全部文档」中递归显示其中的 Markdown 和文本文件，点击路径即可打开。需要层级浏览时切换到「文件树」。
- 在「并排」视图底部可切换同步滚动；「预览」的查找只选中排版文本，不改动源码。编辑权限不足或链接无法校验时可跳到相应源码位置。
- 预览支持 CommonMark、GFM 表格和任务列表、常见语言的围栏代码高亮、授权范围内的相对图片，以及可选的数学公式和 Mermaid 图表。
- 在「预览」或「并排」中，可直接编辑段落、标题和表格单元格。正文输入实时同步到源码，输入法确认候选后同步。预览保留段落内换行和顶层块之间的额外空行，按 Enter 从光标处拆段并继续编辑。修改进入同一份 Markdown 草稿，可跨视图撤销。源码区提供选区工具条、查找替换及代码围栏语言建议。
- 从顶栏「命令」搜索内置或已授权的插件操作。在「设置 → 快捷键」可更改绑定和恢复默认。
- 「设置 → 插件」列出全部官方组件。点击「下载并安装」从 GitHub 获取当前应用版本的组件，装好后可以离线使用、启停或卸载。Windows 首次安装器也可勾选想要的组件，应用首次启动时自动下载所选项。[ExtendownPlugin](https://github.com/KLucen/ExtendownPlugin)
- 点击「GitHub 插件目录 → 查看插件」可下载主题和命令插件，也可用「安装插件文件」导入本地 `.edplugin`。主题在「常规 → 外观」切换。命令插件启用后可在插件设置中直接运行其命令，也可从顶栏「命令」搜索运行；变更会先显示审阅结果。[命令插件开发指南](docs/PLUGIN-DEVELOPMENT.zh-CN.md)
- 从顶栏「导出」选择 HTML、PDF、PNG 或 JPG，在同一个弹窗调整格式选项并查看内容预览。HTML 可离线打开，PDF 以图像分页，PNG 和 JPG 可输出单张图或分段图片 ZIP。

Windows 的 NSIS 安装器默认将核心编辑器安装到 `%LOCALAPPDATA%\extendown\app`，可在向导中修改路径。安装器将 ExtenDown 注册为 `.md` 和 `.markdown` 的候选应用，安装后可从「设置 → 常规 → 选择 .md 默认应用」打开 Windows 系统设置。

每轮开发验收后，使用新版本的 NSIS 安装包覆盖更新桌面应用。升级沿用安装目录和组件选择，需更换资源的组件会在插件页显示「待重新下载」。

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

桌面接入和主题包格式见 [Tauri 接入指南](docs/TAURI-GUIDE.zh-CN.md)。测试范围和环境见 [验收记录](docs/VERIFICATION.zh-CN.md)。产品路线和复用来源见 [编辑体验优化方案](docs/EDITOR-ROADMAP.zh-CN.md)、[首版设计方案](docs/INITIAL_DESIGN.zh-CN.md) 与 [来源清单](PROVENANCE.md)。
