import hljs from 'highlight.js/lib/core';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';

export const additionalHighlighter = hljs.newInstance();
for (const [language, grammar] of Object.entries({ c, cpp, csharp, go, java, lua, markdown, powershell })) {
  additionalHighlighter.registerLanguage(language, grammar);
}
