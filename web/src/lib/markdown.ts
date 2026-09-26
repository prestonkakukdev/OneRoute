import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import { Marked } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const l = (lang || '').split(/\s/)[0] ?? '';
      const html = l && hljs.getLanguage(l) ? hljs.highlight(text, { language: l, ignoreIllegals: true }).value : esc(text);
      return `<pre><code class="hljs${l ? ` language-${esc(l)}` : ''}">${html}</code></pre>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Math is pulled out before Markdown parsing (so `_` and `\` inside formulas survive) and code spans are
// left alone. Inline $...$ needs no space inside the delimiters and no digit after the closing $, so dollar
// amounts like "$4.2M and $4.8M" stay text.
const MATH_RE =
  /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g;

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    return esc(tex);
  }
}

/** Model answer (Markdown + LaTeX) to sanitized HTML. */
export function renderMarkdown(text: string): string {
  const math: string[] = [];
  const src = text.replace(MATH_RE, (m, code, dd, br, pa, inl) => {
    if (code !== undefined) return m;
    math.push(renderMath(String(dd ?? br ?? pa ?? inl).trim(), dd !== undefined || br !== undefined));
    return `MATHPH${math.length - 1}X`;
  });
  const html = DOMPurify.sanitize(marked.parse(src, { async: false }));
  return html.replace(/MATHPH(\d+)X/g, (_, i) => math[Number(i)] ?? '');
}
