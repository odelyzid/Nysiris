/**
 * Small escaped Markdown subset for portal posts/wiki pages.
 *
 * There is no raw HTML path: the parser returns text/spans, and the React
 * renderer escapes every string. Supported: headings, paragraphs, blockquotes,
 * ordered/unordered lists, fenced code, bold, italic, inline code, and links.
 * Links accept only `http(s):` and `nym:` and are rendered as app navigation,
 * never as live page URLs.
 */

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string; language: string }
  | { type: 'list'; ordered: boolean; items: string[] };

export type InlineSpan =
  | { type: 'text'; text: string }
  | { type: 'bold' | 'italic' | 'code'; text: string }
  | { type: 'link'; text: string; href: string };

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = /^```([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', text: code.join('\n'), language: fence[1] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }
    const ordered = /^\d+\.\s+/.test(line);
    const unordered = /^[-*]\s+/.test(line);
    if (ordered || unordered) {
      const items: string[] = [];
      const pattern = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(lines[i].replace(pattern, '').trim());
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const paragraph: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>\s?|```|\d+\.\s+|-{2,}\s+)/.test(lines[i])) {
      if (/^[-*]\s+/.test(lines[i])) break;
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}

/** Parse inline emphasis/code/links; text is returned unescaped for React. */
export function parseInlineSpans(text: string): InlineSpan[] {
  const source = String(text ?? '');
  const spans: InlineSpan[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const rest = source.slice(cursor);
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]);
      if (href) {
        spans.push({ type: 'link', text: link[1], href });
      } else {
        spans.push({ type: 'text', text: link[0] });
      }
      cursor += link[0].length;
      continue;
    }
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      spans.push({ type: 'code', text: code[1] });
      cursor += code[0].length;
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*|^__([^_]+)__/.exec(rest);
    if (bold) {
      spans.push({ type: 'bold', text: (bold[1] ?? bold[2]).trim() });
      cursor += bold[0].length;
      continue;
    }
    const italic = /^\*([^*\n]+)\*|^_([^_\n]+)_/.exec(rest);
    if (italic) {
      spans.push({ type: 'italic', text: (italic[1] ?? italic[2]).trim() });
      cursor += italic[0].length;
      continue;
    }
    const next = nextMarker(rest);
    const plain = next === -1 ? rest : rest.slice(0, next);
    if (plain) spans.push({ type: 'text', text: plain });
    cursor += Math.max(plain.length, next === -1 ? rest.length : 1);
  }
  return spans;
}

export function safeHref(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (/^https?:\/\/\S+$/i.test(value) || /^nym:\/\/\S+$/i.test(value)) return value.slice(0, 4096);
  return null;
}

function nextMarker(rest: string): number {
  const indexes = ['[', '`', '*', '_'].map((marker) => rest.indexOf(marker)).filter((index) => index > 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}
