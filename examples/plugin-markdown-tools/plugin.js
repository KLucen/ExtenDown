// @ts-check

/** @type {import('../../sdk/extendown-plugin').PluginRun} */
function run(input) {
  const document = input.document;
  if (!document) return { message: '当前文档不可用。' };

  switch (input.command) {
    case 'org.example.markdown-tools.statistics': {
      let count = 0;
      for (const _character of document.source) count++;
      return { message: '字符数 ' + count };
    }
    case 'org.example.markdown-tools.final-newline':
      if (document.source.length === 0 || document.source.endsWith('\n')) {
        return { message: '无需补充文末换行。' };
      }
      return { message: '已准备文末换行。', source: document.source + '\n' };
    default:
      throw new Error('未知命令');
  }
}
