/*
 * Tiny markdown renderer for Marco's replies, ported from the Prelude Chat
 * mock-up. Covers the subset a short model answer can plausibly contain —
 * paragraphs, **bold**, *italics*, `inline code`, bulleted and numbered
 * lists, blockquotes, fenced code blocks — and escapes everything else, so
 * plain prose passes through unchanged. Every fragment of output text goes
 * through esc(), so the returned HTML string is safe to inject.
 */

const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s([])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

export function renderMarkdown(src) {
  const code = [];
  let text = src.replace(/```([a-z]*)\n?([\s\S]*?)```/gi, (m, lang, body) => {
    code.push(body);
    return '\n@@CB' + (code.length - 1) + '@@\n';
  });
  // An unclosed fence at the end (mid-stream) still renders as a code block.
  text = text.replace(/```([a-z]*)\n?([\s\S]*)$/i, (m, lang, body) => {
    code.push(body);
    return '\n@@CB' + (code.length - 1) + '@@\n';
  });

  const lines = text.split('\n');
  const out = [];
  let i = 0;
  const blank = (l) => /^\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }

    const block = line.trim().match(/^@@CB(\d+)@@$/);
    if (block) {
      out.push('<pre><code>' + esc(code[+block[1]].replace(/\n+$/, '')) + '</code></pre>');
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const paras = buf.join('\n').split(/\n\s*\n/).filter((p) => !blank(p));
      out.push(
        '<blockquote>' +
          paras.map((p) => '<p>' + inline(p.replace(/\n/g, ' ').trim()) + '</p>').join('') +
        '</blockquote>'
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push('<ul>' + buf.map((t) => '<li>' + inline(t) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + buf.map((t) => '<li>' + inline(t) + '</li>').join('') + '</ol>');
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      !blank(lines[i]) &&
      !/^\s*([-*]\s+|\d+\.\s+|>)/.test(lines[i]) &&
      !/^@@CB\d+@@$/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push('<p>' + inline(para.join(' ').trim()) + '</p>');
  }
  return out.join('');
}

// While streaming, an odd trailing marker ("**", "`") would flash as literal
// punctuation for a frame; trim it from the paint until its partner arrives.
export const trimDanglingMarkdown = (s) => s.replace(/[`*_]{1,3}$/, '');
