/**
 * React renderer for the escaped portal Markdown subset.
 * All text is rendered as text nodes; links become app navigation buttons.
 */
import { Fragment } from 'react';
import { parseInlineSpans, parseMarkdownBlocks } from '../../../application/portalMarkdown';

export function PortalMarkdown({ text, onOpenLink }: { text: string; onOpenLink: (href: string) => void }) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="fly-portal-markdown">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading': {
            const Tag = block.level <= 2 ? 'h4' : 'h5';
            return <Tag key={index}>{inline(block.text, onOpenLink)}</Tag>;
          }
          case 'paragraph':
            return <p key={index}>{inline(block.text, onOpenLink)}</p>;
          case 'quote':
            return (
              <blockquote key={index}>
                <InlineText text={block.text} onOpenLink={onOpenLink} />
              </blockquote>
            );
          case 'code':
            return (
              <pre key={index} className="fly-portal-code">
                <code>{block.text}</code>
              </pre>
            );
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item, onOpenLink)}</li>
                ))}
              </List>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

function InlineText({ text, onOpenLink }: { text: string; onOpenLink: (href: string) => void }) {
  return <>{inline(text, onOpenLink)}</>;
}

function inline(text: string, onOpenLink: (href: string) => void) {
  return parseInlineSpans(text).map((span, index) => {
    switch (span.type) {
      case 'bold':
        return <strong key={index}>{span.text}</strong>;
      case 'italic':
        return <em key={index}>{span.text}</em>;
      case 'code':
        return (
          <code key={index} className="fly-portal-inline-code">
            {span.text}
          </code>
        );
      case 'link':
        return (
          <button
            key={index}
            type="button"
            className="fly-portal-link"
            onClick={() => onOpenLink(span.href)}
            title={span.href}
          >
            {span.text}
          </button>
        );
      default:
        return <Fragment key={index}>{span.text}</Fragment>;
    }
  });
}
