/**
 * Print the active document without printing the browser chrome.
 *
 * HTML documents are already sanitised and self-contained (CSS/images are
 * inlined as data URLs by the content loader), so they are written verbatim
 * into a new same-origin window. Text/JSON is escaped and wrapped in `<pre>`.
 */

export interface PrintDocumentOptions {
  title: string;
  html?: string | null;
  text?: string | null;
  /** Optional inline image/data URL (image pages). */
  imageUrl?: string | null;
}

export function buildPrintDocument(options: PrintDocumentOptions): string {
  const title = escapeHtml(options.title || 'nysiris');
  let body: string;
  if (options.html) {
    body = options.html;
  } else if (options.imageUrl && /^data:image\//i.test(options.imageUrl)) {
    body = `<img src="${escapeAttribute(options.imageUrl)}" alt="${title}">`;
  } else {
    body = `<pre>${escapeHtml(options.text ?? '')}</pre>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 16mm; color: #111; background: #fff; font: 14px/1.5 system-ui, sans-serif; }
  img, video, svg { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; word-break: break-word; font: 12px/1.45 ui-monospace, monospace; }
  a { color: #111; text-decoration: underline; }
  @media print { body { margin: 10mm; } a[href]::after { content: ""; } }
</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Open a print-only window and trigger the dialog. Returns false when the
 * browser blocked the popup; the caller can then offer `window.print()`.
 */
export function printDocument(options: PrintDocumentOptions): boolean {
  if (typeof window === 'undefined') return false;
  const printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) return false;
  try {
    printWindow.document.open();
    printWindow.document.write(buildPrintDocument(options));
    printWindow.document.close();
    const trigger = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch {
        // The window may have been closed before printing.
      }
    };
    if (printWindow.document.readyState === 'complete') window.setTimeout(trigger, 100);
    else printWindow.addEventListener('load', () => window.setTimeout(trigger, 100), { once: true });
    return true;
  } catch {
    try {
      printWindow.close();
    } catch {
      // Ignore.
    }
    return false;
  }
}

export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
