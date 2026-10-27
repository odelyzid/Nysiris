/**
 * DOM-side find-in-page for the same-origin sandboxed document.
 *
 * Kept out of the pure matcher so the shell can highlight matches in an iframe
 * without pulling DOM types into `node --test`.
 */
import { findMatches } from '../../../application/find';

const HIT = 'fly-find-hit';
const CURRENT = 'fly-find-current';
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'TITLE']);

export function clearFindHighlights(doc: Document): void {
  const marks = [...doc.querySelectorAll(`mark.${HIT}`)];
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parents.add(parent);
    parent.replaceChild(doc.createTextNode(mark.textContent ?? ''), mark);
  }
  for (const parent of parents) parent.normalize();
}

/**
 * Wrap every text-node match in `<mark>`. Returns the marks in document order,
 * capped by the pure matcher's limit.
 */
export function highlightFindMatches(doc: Document, query: string): HTMLElement[] {
  clearFindHighlights(doc);
  if (!query.trim() || !doc.body) return [];
  if (typeof doc.createTreeWalker !== 'function' || typeof doc.createRange !== 'function') return [];

  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || node.nodeValue.trim().length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) textNodes.push(node as Text);
  }

  const marks: HTMLElement[] = [];
  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    const matches = findMatches(text, query);
    if (matches.length === 0) continue;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) fragment.appendChild(doc.createTextNode(text.slice(cursor, match.start)));
      const mark = doc.createElement('mark');
      mark.className = HIT;
      mark.textContent = text.slice(match.start, match.end);
      fragment.appendChild(mark);
      marks.push(mark);
      cursor = match.end;
    }
    if (cursor < text.length) fragment.appendChild(doc.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return marks;
}

export function focusFindMatch(marks: HTMLElement[], index: number): void {
  for (const mark of marks) mark.classList.remove(CURRENT);
  const target = marks[index];
  if (!target) return;
  target.classList.add(CURRENT);
  try {
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {
    // Older engines: scrollIntoView options are optional.
    target.scrollIntoView();
  }
}
