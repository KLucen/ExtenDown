export const COMPONENT_CATEGORIES = {
  writing: '写作与渲染',
  export: '导出',
  view: '视图',
  appearance: '外观',
  command: '本地命令',
} as const;

export const OFFICIAL_COMPONENTS = [
  { id: 'math', category: 'writing', name: '数学公式', aliases: 'math katex latex 矩阵 equation', description: '显示 LaTeX 行内和块级公式', entries: ['math-engine.ts'] },
  { id: 'mermaid', category: 'writing', name: 'Mermaid 图表', aliases: '画流程图 时序图 甘特图 diagram flowchart', description: '从 Markdown 围栏绘制流程图和时序图', entries: ['mermaid-engine.ts'] },
  { id: 'languages', category: 'writing', name: '额外代码语言', aliases: '高亮 代码着色 c++ go java powershell syntax', description: '为更多语言的代码块着色', entries: ['additional-languages.ts'] },
  { id: 'html', category: 'export', name: 'HTML 导出', aliases: '网页 离线 web', description: '生成可离线浏览的网页', entries: ['save-html-export.ts'] },
  { id: 'pdf', category: 'export', name: 'PDF 导出', aliases: '分页 打印', description: '生成分页的 PDF', entries: ['raster-export.ts', 'pdf-engine.ts'] },
  { id: 'images', category: 'export', name: 'PNG / JPG 导出', aliases: '图片 长图 jpeg zip', description: '生成单张或分段图片', entries: ['raster-export.ts'] },
  { id: 'focus', category: 'view', name: '专注视图', aliases: 'focus 阅读 演示', description: '扩大阅读区域', entries: ['focus-view.ts'] },
  { id: 'theme', category: 'appearance', name: 'Midnight 主题', aliases: 'theme dark 外观 深色', description: '提供一套深色界面和阅读配色', entries: ['official-theme.ts'] },
] as const;

export type ComponentId = typeof OFFICIAL_COMPONENTS[number]['id'];
export type ComponentCategory = keyof typeof COMPONENT_CATEGORIES;
export type ExtensionState = 'enabled' | 'disabled' | 'missing' | 'loading';
export const EXTENSION_STATE_LABELS: Record<ExtensionState, string> = {
  enabled: '已启用', disabled: '已停用', missing: '未安装', loading: '正在检查',
};
export const COMPONENT_PRESETS = {
  minimal: ['html'] as readonly ComponentId[],
  recommended: OFFICIAL_COMPONENTS.map(item => item.id) as readonly ComponentId[],
};

export function matchesComponent(query: string, ...fields: string[]): boolean {
  const searchable = fields.join(' ').toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/u).every(term => searchable.includes(term));
}
