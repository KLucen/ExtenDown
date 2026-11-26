# ExtenDown 首版产品与插件生态设计方案

版本草案 0.1 · 2026-11-26

## P4 当前实现

第三方 JavaScript 插件可从「设置 → 插件」安装本地 `.edplugin` 命令包。启用时确认版本和文档权限。插件在独立 Worker 内的 QuickJS WASM 环境运行，按授权接收当前文档的源码与修订号。宿主复核授权和文档修订，用户审阅后才能将候选源码写入草稿。

安装记录保存在应用的 IndexedDB。手动更新保留上一个版本，回滚后需重新授权。P4 当前对自装脚本开放命令贡献、文档读取及文档变换。插件目录、自动更新、额外贡献类型和网络桥接保留在后续路线。[命令插件开发指南](PLUGIN-DEVELOPMENT.zh-CN.md)

## 当前实现（P1–P3）

- 窗口采用单行紧凑顶栏。源码、并排和预览位于可收起的左侧栏。桌面宿主可打开与保存 `.md`、`.markdown` 和 `.txt`，并提供多窗口、保存冲突提示和草稿恢复。Windows 安装器注册 Markdown 文件关联候选项，默认应用由用户在系统设置中选定。
- 数学公式由 KaTeX 离线生成 MathML，Mermaid 围栏可离线生成图表。围栏代码支持常见语言高亮。用户在「设置 → 插件」管理扩展，可安装数据型 `.edplugin` 主题包。
- Windows 安装器提供官方组件选择，将所选扩展模块安装在应用目录。基础语法、浅色和深色主题，以及原生文件和窗口服务始终安装。
- 导出使用当前文档快照，桌面宿主提供原生保存对话框。HTML 生成可离线打开的单文件，PDF 以图像分页，PNG 和 JPG 可输出单张图或分段图片 ZIP。

下文保留首版设计与后续路线。当前操作、主题包格式和导出限制见 [Tauri 接入指南](TAURI-GUIDE.zh-CN.md)。验收范围见 [验收记录](VERIFICATION.zh-CN.md)。

## 1. 产品定位

ExtenDown 是一款面向本地文档的桌面 Markdown 编辑器，提供源码编辑、排版预览与常用文档导出。首版沿用 MerMarkd 已验证的编辑和阅读组件，以 Tauri v2 承担文件、窗口和系统集成，前端继续使用 React、TypeScript、Vite 与 CodeMirror 6。

设计基调为简洁、安静、适合长时间写作。主窗口围绕文档和编辑区组织，工具栏只保留打开、保存、视图切换、查找、导出和主题入口。源码、预览与分屏使用同一文档缓冲区，切换视图不改变正文。默认采用浅色主题，并提供深色主题和清晰的未保存、冲突及导出状态。

## 2. P0 复用基础

| 代码 | 已有能力 | 首版中的作用 |
| --- | --- | --- |
| `src/renderer/source-surface.tsx` | CodeMirror 源码编辑、选区和跳转、软换行、输入法组合输入处理 | 作为源码编辑器组件，接入文档会话与统一撤销历史 |
| `src/renderer/markdown-preview.tsx`、`reader-markdown.tsx` | 基于 React 的只读 Markdown 预览，按完整语义块渲染 | 作为预览模式与导出渲染器的前端基础 |
| `src/core/` | Markdown 解析投影、标题目录、源码映射、UTF-8/BOM/换行处理和安全清洗 | 保留为不依赖 Tauri 的文档核心层 |
| `src/demo/main.tsx` | 源码、预览、分屏共享缓冲区的演示 | 迁移到正式应用外壳，替换浏览器文件输入和下载流程 |
| `src-tauri/` | Tauri v2 桌面壳和单窗口配置 | 增加 Rust 文档服务、窗口管理、导出调用和精确权限 |

P0 预览支持 CommonMark、GFM、YAML frontmatter 和受限 HTML 清洗。源码编辑保留 UTF-8 BOM 和换行元数据，导入与下载使用浏览器 API，单文档上限为 2 MiB。桌面壳在这一阶段用于启动和验收单窗口编辑界面。文件来源见 [来源清单](../PROVENANCE.md)。

## 3. 0.1 版本内容与功能归属

0.1 采用“核心必有、官方扩展默认安装、第三方扩展受控接入”的边界。用户关闭所有可选扩展后，仍能编辑、保存和预览常规 Markdown。PDF、位图导出和数学公式列为可选包，但标准安装默认勾选，确保首版开箱覆盖目标格式。

| 能力 | 归属 | 0.1 实现与安装策略 |
| --- | --- | --- |
| 源码编辑、预览、分屏、撤销、目录和查找 | 核心 | 始终安装，所有视图共用文档缓冲区和修订历史 |
| CommonMark、GFM、frontmatter、围栏代码块、HTML 清洗 | 核心 | 始终安装；常见代码语言高亮随核心提供，扩展语言包可选 |
| 文件读写、保存冲突、恢复、最近文档、窗口和路径权限 | 原生宿主 | Rust/Tauri 内置，始终安装，权限只通过窄业务命令开放 |
| Markdown 与纯文本导入，Markdown 原文导出 | 核心 | 始终安装；读取文件和写入目标由原生宿主授权 |
| HTML、PDF、PNG、JPG 导出 | 官方导出扩展 | 每个格式使用独立 exporter 模块。标准安装默认安装，定制安装可取消；PDF 调用宿主打印能力，图片导出调用宿主保存对话框 |
| 浅色、深色和主题令牌系统 | 核心 | 两个基础主题始终可用，保证插件停用后界面仍完整 |
| 额外主题包 | 数据型扩展 | 可在安装器选择，也可在“设置 → 插件”安装 `.edplugin` 主题包 |
| 数学、Mermaid 等额外语法 | 官方语法扩展 | 数学包随标准安装默认安装，定制安装可取消；Mermaid 可作为独立可选包 |
| 额外阅读/演示模式 | 视图扩展 | 源码、预览、分屏属于核心；卡片、演示、专注等作为可选视图模块 |
| DOCX、HTML、Org 等额外导入格式 | 导入扩展 | 通过 importer 注册表接入，按需安装 |
| 用户编写的 JavaScript 插件 | 后续生态能力 | 完成隔离执行器和权限桥接后开放，0.1 用户自装插件先限数据型主题 |

定制安装页提供组件复选项，至少包含数学、Mermaid、PDF、PNG/JPG、演示/专注视图、额外代码语言包和官方主题包。支持可选组件的安装器只复制已选择的独立模块包；不支持该安装器交互的平台在首次启动时提供相同选项。已安装的官方包可以启用或停用。用户自行安装的包可在插件管理器卸载，官方包的物理增删由应用安装器或应用更新处理。核心原生宿主不出现在可选列表里。

HTML 导出将样式和允许的本地图片嵌入文件，生成可离线阅读的单文件。PDF 使用分页样式和系统打印到 PDF 流程，提供纸张、方向、边距与缩放。PNG/JPG 使用独立导出页面栅格化，长文档提供分页图片或按页导出；JPG 使用可配置的实色背景。导出需要报告尺寸限制、失败原因和实际输出路径，不能静默裁切内容。

Markdown 内容仍以 `.md` 文件为唯一正文来源。文档会话保存稳定标识、路径、磁盘摘要、源格式、修订号和草稿状态。Rust 侧根据用户选择的文件路径读取和写入，前端只通过 `DocumentHost` 业务接口访问文档，不接收通用文件系统权限。相对资源在 Rust 侧校验实际路径后提供给预览和导出。

### 3.1 核心功能的验收边界

- 所有扩展停用时，新建、打开、源码编辑、预览、分屏、查找、保存和 Markdown 原文导出仍可用。
- 常见 Markdown 语法、GFM、frontmatter 和安全 HTML 策略由核心维护，插件不能替换或绕开核心 sanitizer。
- 文档缓冲区、撤销历史、磁盘基线、窗口和插件权限由宿主管理，扩展不能自行打开任意路径或覆盖文件。
- 默认主题永远存在。扩展贡献冲突或加载失败时，核心编辑和默认预览继续可用。
- 0.1 明确提供 HTML、PDF、PNG、JPG 官方导出模块，标准安装默认包含它们。插件架构同时允许后续增加 EPUB、DOCX、LaTeX 等导出格式。

## 4. 应用结构

```text
React 窗口
  编辑/预览界面 · 导航与命令 · 插件贡献展示
          │ 类型化 DocumentHost 与 PluginHost API
TypeScript 文档核心
  Markdown 缓冲区 · 解析投影 · 安全清洗 · 扩展注册表 · 导出模板
          │ 最小 Tauri command 集合
Rust 桌面宿主
  文档会话 · 文件授权与保存 · 多窗口注册 · 原生对话框 · 导出任务
```

每个窗口持有 `windowId` 和当前 `documentId`，应用进程的文档管理器负责路径去重和保存串行化。视图状态属于窗口，文档文本和磁盘基线属于文档会话。保存命令携带文档标识与单调递增的修订号，避免旧窗口状态覆盖较新编辑。Tauri capability 按窗口与命令逐项配置，CSP 仅开放应用需要的协议和资源。

## 5. 插件分类、接口与接入

### 5.1 原生 Tauri 模块

原生模块负责进程、系统和文件边界，使用 Rust 编译并随 ExtenDown 安装包发布。文档读取/安全保存、文件选择器、路径授权、窗口创建和去重、系统打印、图片输出路径选择，以及需要访问操作系统的外链打开，均由原生宿主提供。前端通过少量有类型的 command 调用这些能力，每个窗口的 capability 只授予实际需要的命令。

原生 Tauri 插件属于可信应用代码和依赖项，随程序编译、测试、签名和升级。0.1 不支持用户复制 `.dll`、`.so`、`.dylib` 或 Rust 动态库进入插件目录运行，也不在安装器里拆分原生文件服务。第三方原生代码能取得进程权限并影响文件安全，必须经过项目代码审查和正式应用更新发布。安装器可选择的是受控的扩展包，不是原生宿主能力。

PDF exporter 是两层实现。TypeScript 模块负责导出选项、统一导出任务和结果反馈，Rust/Tauri 打印桥负责系统 WebView 的 PDF 输出。PDF 模块可选装卸，打印桥作为原生宿主随应用提供。PNG/JPG exporter 也通过宿主选择目标文件，渲染模块不自行访问任意路径。

### 5.2 扩展点与归属

| 扩展点 | 插件提供内容 | 宿主负责内容 |
| --- | --- | --- |
| `theme` | 经 schema 校验的颜色、字体、阅读宽度等令牌 | 默认主题、令牌校验、CSS 变量映射、切换状态 |
| `markdown` | 语法声明、可信内置解析器或后续沙箱化转换器 | 核心解析顺序、版本标记、HTML/URL sanitizer 和失败回退 |
| `render-mode` | 额外阅读、卡片、演示或专注视图 | 文档快照、视图注册、窗口导航和错误隔离 |
| `importer` | 文件扩展名、MIME、导入选项和 Markdown/资源转换器 | 原生文件选择、路径授权、导入事务、资源目录和最终保存 |
| `exporter` | 格式 ID、文件扩展名、选项 schema 和输出生成器 | 当前修订快照、保存对话框、输出文件句柄、取消和错误状态 |
| `command` | 可访问的命令名、快捷键建议和处理器 | 菜单/工具栏挂载、快捷键冲突提示和权限检查 |

CommonMark、GFM、frontmatter 与源/预览/分屏是核心语义。新增方言、视图、导入格式和导出格式通过这些注册点扩展。扩展不能接管文件会话、撤销历史、窗口身份、安全清洗和保存冲突处理。

### 5.3 包格式与 Manifest

插件包后缀统一为 `.edplugin`，容器采用 ZIP，安装前由宿主检查文件路径、解压大小和文件数量，拒绝目录穿越、重复路径、符号链接和超出限制的压缩包。每个包包含 `manifest.json`、入口或数据文件和静态资源。Manifest 使用仓库中的 JSON Schema 校验。

主题示例只含数据，不含脚本。

```text
midnight-theme.edplugin
  manifest.json
  theme.json
  preview.png
```

```json
{
  "schemaVersion": 1,
  "id": "org.example.midnight-theme",
  "name": "Midnight",
  "version": "1.0.0",
  "hostApi": "^1.0.0",
  "kind": "theme",
  "entry": "theme.json",
  "contributes": ["theme:midnight"],
  "permissions": [],
  "dependencies": {}
}
```

Manifest 必填字段为 `schemaVersion`、全局唯一 `id`、`name`、SemVer `version`、`hostApi` 范围、`kind`、相对入口 `entry`、`contributes`、`permissions` 和依赖。依赖声明给出插件 ID 和兼容版本范围。网络权限使用结构化声明并列出允许域名，例如 `{"name":"network.fetch","domains":["api.example.com"]}`。未知宿主 API 主版本、缺失依赖、重复贡献 ID 或不满足权限要求的包保持停用并给出原因。

0.1 的 `kind` 包含 `theme`、`markdown`、`render-mode`、`importer`、`exporter` 和 `command`。只有 `theme` 可由用户提供脚本外的 `.edplugin` 包启用。其余 kind 是可信官方模块，用户代码版留待隔离运行时验收后开放。`hostApi` 使用 SemVer 区间，主版本不兼容时禁用，向后兼容的次版本可声明新增能力。

主题令牌示例展示可校验的值类型。正式 schema 还会约束字体栈长度、令牌集合、字符串长度和颜色格式。

```json
{
  "schemaVersion": 1,
  "tokens": {
    "surface": "#f4f6f8",
    "text": "#20242a",
    "accent": "#1769aa",
    "fontFamily": "system-ui, sans-serif",
    "readingWidth": "68rem"
  }
}
```

### 5.4 模块代码和注册接口

官方扩展放在 `plugins/builtin/<plugin-id>/`，由主应用构建系统打包。建议的代码职责如下。

```text
schemas/
  plugin-manifest.schema.json
src/core/plugins/
  manifest-schema.ts       # Manifest 解析与校验
  contracts.ts             # API 版本、贡献类型和错误合同
  registry.ts              # 贡献注册、依赖顺序、冲突检查
  lifecycle.ts             # 启停、失败隔离和 dispose 管理
  builtin-modules.ts       # 官方模块目录和依赖顺序
src/renderer/settings/plugins/
  PluginManager.tsx        # 已安装、安装入口、兼容性和错误状态
src-tauri/src/plugins/
  install.rs               # ZIP 校验、目录和安装事务
  bridge.rs                # 原生能力的窄 IPC 接口
plugins/builtin/
  export-html/
  export-pdf/
  export-raster/
  markdown-math/
  theme-sample/
```

可信官方 TypeScript 模块通过统一接口注册贡献。禁用或卸载时要释放所有注册项和监听器。

```ts
export interface BuiltinModule {
  readonly manifest: BuiltinManifest;
  activate(host: BuiltinHost): void | (() => void);
}

export interface BuiltinHost {
  readonly markdown: MarkdownRegistry;
  readonly views: RenderModeRegistry;
  readonly importers: ImporterRegistry;
  readonly exporters: ExporterRegistry;
  readonly commands: CommandRegistry;
}
```

注册表采用统一的“注册并返回注销句柄”合同。主题令牌由 Manifest 加载流程校验，代码贡献通过对应 registry 注册。

| Registry | 注册项 | 用途 |
| --- | --- | --- |
| `markdown` | 可信的 remark/rehype 编译器扩展 | 在明确解析阶段增加语法或投影 |
| `views` | 官方 React 视图模块 | 从同一文档快照提供一种新阅读模式 |
| `importers` | 导入器描述与转换函数 | 将宿主选取的输入转换成候选 Markdown 和资源 |
| `exporters` | 导出器描述与输出函数 | 将只读文档快照写入宿主创建的输出 sink |
| `commands` | 命令 ID、可见名称和执行函数 | 注册菜单、工具栏或快捷键动作 |

每个 `register(...)` 返回 `() => void`，供模块停用时撤销。官方视图模块可以使用 React 组件，未来第三方视图插件只提交可序列化的视图模型，由宿主渲染。

Exporter 契约由核心类型包定义，插件不自行弹出文件对话框，也不接收目标路径。

```ts
export interface ExporterContribution {
  readonly id: string;
  readonly fileExtensions: readonly string[];
  readonly optionsSchema: JsonSchema;
  run(
    snapshot: Readonly<DocumentSnapshot>,
    target: ExportTarget,
    options: ValidatedOptions,
  ): Promise<void>;
}

export interface ExportTarget {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: ExportError): Promise<void>;
}
```

官方 HTML 模块的接入形状如下。PNG/JPG 使用 `export-raster`，PDF 使用 `export-pdf`，差异封装在各自 exporter 内。

```ts
export const htmlExporter: BuiltinModule = {
  manifest: htmlManifest,
  activate(host) {
    return host.exporters.register({
      id: 'org.extendown.export.html',
      fileExtensions: ['html'],
      optionsSchema: htmlOptionsSchema,
      async run(snapshot, target, options) {
        const html = await renderOfflineHtml(snapshot, options);
        await target.write(new TextEncoder().encode(html));
        await target.close();
      },
    });
  },
};
```

`builtin-modules.ts` 列出内置模块描述，不把 exporter 调用写进编辑器组件。Vite 构建为每个可选模块输出独立入口、样式、资源和 Manifest。应用启动时，核心先加载基础 API，再按安装清单和用户启停设置动态加载模块。模块 API 不兼容或动态加载失败时，核心隐藏对应菜单项并提供错误详情。

导出模块接收不可变的 `DocumentSnapshot`，包含源码、修订号、方言和已经授权的资源句柄。输出目的地由宿主创建并作为受限 sink 提供，模块不接收绝对路径。导入模块接收宿主读取的字节和受限资源集合，返回候选 Markdown 与资源清单，再由用户确认是否写入文档。

插件管理器按依赖关系排序，之后按稳定 ID 处理无依赖模块。贡献 ID 冲突时拒绝后加载的一方，不覆盖核心贡献。插件停用、异常或依赖失效时，宿主调用 `dispose` 并恢复核心渲染器、默认主题和基础命令。

### 5.5 第三方插件的运行边界

0.1 允许用户安装主题类 `.edplugin` 数据包。主题 JSON 只接受定义好的令牌和安全字体栈，不能包含任意 CSS、`url()`、脚本、HTML 或 Tauri 权限。0.1 的 Markdown 解析器和导出器以官方内置扩展包交付，不执行用户下载的 JavaScript。

后续开放通用 JavaScript 插件时，业务逻辑默认运行在 Web Worker。宿主与 Worker 以带版本号的消息 RPC 交换声明式数据，不传递 React DOM、CodeMirror 对象、Tauri `invoke` 或任意文件路径。额外交互面板需要 iframe 时使用无同源权限的 sandbox iframe，并采用独立 CSP。插件 API 默认无权限，按单个 capability 授权，例如 `document.read`、`document.transform`、`export.create` 和 `network.fetch`。文档变换先返回候选结果供核心校验，文件写入仍由宿主完成。

通用插件失败要有执行超时、输出大小上限、取消、日志和单插件禁用机制。Markdown 插件输出始终经过宿主 sanitizer。远程插件目录和自动更新待包签名、来源验证、回滚及兼容性测试完成后再上线。

未来可执行插件的 capability 初始设为空，并在安装确认页逐项展示。

| Capability | 授权内容 | 宿主边界 |
| --- | --- | --- |
| `document.read` | 读取用户当前选择的文档快照 | 只读当前文档，不暴露路径或其他打开文档 |
| `document.transform` | 提交候选 Markdown 变更 | 核心校验差异并由用户确认后写入缓冲区 |
| `export.create` | 请求创建导出任务 | 宿主选择目标路径并提供受限输出 sink |
| `network.fetch` | 插件声明域名的网络访问 | 默认关闭，单独授权并限定域名和协议 |

不提供 `filesystem.*`、原生命令、进程启动、任意 `invoke` 或通用 DOM 权限。主题插件不含可执行代码，因此权限集合固定为空。

### 5.6 插件如何开发和接入

官方模块开发按以下步骤完成。

1. 在 `plugins/builtin/<plugin-id>/` 创建模块，声明唯一 ID、版本、`hostApi`、贡献类型、依赖和所需 capability。
2. 只依赖 `Plugin API` 暴露的注册表。导入器返回候选文档，exporter 从只读快照生成输出，主题提交符合 schema 的令牌。
3. 在 `src/core/plugins/builtin-modules.ts` 登记模块，并在构建配置中生成模块资源和包清单。
4. 为启用、停用、冲突、异常、取消、超限和版本不兼容添加单测。涉及 parser、HTML 或资源时增加恶意输入测试。
5. 构建 `.edplugin`，由插件管理器从本地文件安装。管理器校验包、展示贡献和权限、确认后原子放入用户插件目录并重载对应注册表。

第三方主题作者在 0.1 按照 Manifest schema 创建 `manifest.json` 和 `theme.json`，运行官方校验器后打包 `.edplugin`，在应用中选择“设置 → 插件 → 安装插件文件”。后续第三方代码插件使用 SDK 生成 worker 入口和类型定义，通过相同 API 版本、Manifest 与贡献注册合同接入。项目实现 API 后应提供 `create-extendown-plugin` 脚手架、示例仓库、类型包、校验 CLI 和插件开发指南。

### 5.7 插件目录和生命周期

- 官方随安装包提供的模块位于只读资源目录 `resources/plugins/`，记录来源为 `bundled`。安装器只把用户选择的可选包复制到该目录。
- 用户安装包解压到 Tauri `appDataDir/plugins/installed/<id>/<version>/`。启停状态和用户设置放在 `appConfigDir/plugins/registry.json`，用户数据与应用升级分离。
- 临时安装包写入 `appCacheDir/plugins/staging/`。校验成功后再移动到目标目录，避免安装中断留下半个可运行包。
- 用户通过“安装插件文件”安装同 ID 的较新版本时，管理器先保留旧版本并暂存新包。新版本通过校验且激活成功后再切换；激活失败则恢复旧版本。卸载先停用并释放贡献，再删除程序文件；是否清除插件数据由用户单独选择。
- 用户在“设置 → 插件”查看已安装模块并执行启用、停用；用户包还可以卸载。页面显示版本、来源、兼容状态、权限和错误，提供“安装插件文件”。官方扩展包随 ExtenDown 应用更新交付。0.1 不提供应用内插件市场或后台插件自动更新。

首次安装页提供“标准安装”和“定制安装”。定制项只包括官方 web 扩展包和语言资源。运行中的原生宿主模块不会被插件管理器移除。标准安装默认包含 HTML、PDF、PNG/JPG、数学、常见代码语言包、演示/专注视图和默认主题。定制安装可以不复制其中的可选包。用户可从 ExtenDown 官方发布页下载 `.edplugin` 后通过“安装插件文件”补装，也可安装自行制作的数据型主题包。0.1 不内置公开插件市场。

## 6. 简洁界面与主要流程

主窗口包含紧凑标题栏、模式切换、文档操作和编辑区。分屏初始比例约为源码 50%、预览 50%，用户可拖动分隔线。文档目录和搜索使用可收起侧栏，不常驻展示额外信息。主题、快捷键和导出选项放在菜单或弹窗中，图标操作提供可访问名称与提示。

打开文档后，用户在源码或分屏中编辑。预览按同一修订更新。保存由主进程确认磁盘基线并安全替换。新窗口拥有独立视图状态，文档窗口之间通过应用进程的会话管理协调。导出前确认使用当前草稿，预览结果后选择路径和格式。

## 7. 开发阶段

| 阶段 | 交付 | 完成条件 |
| --- | --- | --- |
| P0 项目基线 | 把复用组件接入 ExtenDown 项目，完成正式应用标识、依赖锁定、跨平台 Tauri 启动和文档 | 可在浏览器和 Windows WebView2 运行；源码、预览、分屏共享缓冲区；现有 51 项测试通过 |
| P1 文档闭环 | 原生打开、保存、另存为、恢复草稿、冲突处理、多窗口和相对图片 | BOM/换行往返正确；外部修改不被覆盖；窗口关闭保护有效；同一文件路径去重；打包版完成验收 |
| P2 插件宿主与官方扩展 | 插件 Manifest/API、注册表、主题插件管理、常见代码语言包、数学模块 | API 兼容性和依赖检查生效；主题 JSON schema 拒绝非法样式值；停用后无残留贡献 |
| P3 可选导入导出与视图 | HTML、PDF、PNG、JPG 官方 exporter；可选 Mermaid/演示模式；定制安装项 | 中文、图片、长代码块、分页和大图边界通过；格式模块可独立启停；输出绑定当前修订 |
| P4 第三方代码生态 | 隔离的 JavaScript 插件、权限授权、更新和回滚、脚手架与开发文档 | 权限测试证明插件不能越权读写文件、网络或主窗口；插件崩溃不影响核心编辑器 |

## 8. 0.1 验收清单

- 在同一份含中文、emoji、BOM、CRLF、表格、嵌套列表、代码块、公式和相对图片的 Markdown 中完成打开、编辑、撤销、保存、另存和重开。
- 源码、预览、分屏始终对应同一个文档修订；切换模式不丢选区、输入法组合状态或未保存内容。
- 同时打开不同文档窗口，分别编辑并保存；再次打开已存在路径时聚焦原窗口。外部修改出现明确冲突，不静默覆盖。
- GFM、frontmatter、代码高亮、数学扩展和原始 HTML 清洗各有固定 fixture；恶意协议、越权图片路径和危险 HTML 不执行、不读取。
- HTML 离线打开；PDF 页面和中文字体正确；PNG/JPG 清晰且长文档分段完整；失败、取消和超限均有可理解状态。
- 定制安装能选择官方数学、PDF、PNG/JPG、额外语言包、主题包和演示/专注视图；“设置 → 插件”可查看已安装模块、执行启停并从文件安装主题包；用户包可以卸载。
- 数据型主题插件安装、启用、切换、停用和移除可重复完成；非法令牌、重复贡献 ID、宿主 API 不兼容均有诊断并保留核心编辑能力。
- 原生文件、窗口和打印桥仅由随应用编译的 Tauri 模块提供；用户插件无法加载动态库、调用任意 Tauri command 或取得绝对路径。
- `npm test`、`npm run build`、`cargo check --locked` 和 Windows 打包版的文件、多窗口、导出验收通过。
