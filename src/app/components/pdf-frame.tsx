import { useState, useEffect } from 'react';
import { Maximize2, X, ExternalLink } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';

interface PdfFrameProps {
  /** iframe source URL for the PDF */
  src: string;
  /** accessible title / filename shown in the fullscreen header */
  title: string;
  /** link opened by the "open in new tab" button; defaults to src */
  href?: string;
  /** extra classes for the wrapper (defaults keep it filling a flex column) */
  className?: string;
}

/**
 * Inline PDF preview that fills its container, with a maximize button that
 * opens the same PDF in a fullscreen dialog. Used by every receipt/statement
 * preview pane so small split-pane previews can be blown up to full size.
 */
export function PdfFrame({ src, title, href, className }: PdfFrameProps) {
  const [expanded, setExpanded] = useState(false);
  const link = href ?? src;

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <div className={cn('relative flex-1 flex min-h-0 w-full', className)}>
      <iframe src={src} className="flex-1 w-full border-0" title={title} />

      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="absolute top-2 right-2 p-1.5 rounded bg-background/90 border border-border shadow-sm text-muted-foreground hover:text-foreground hover:bg-accent"
        title={t('pdf.fullscreen')}
        aria-label={t('pdf.openFullscreen')}
      >
        <Maximize2 className="h-4 w-4" />
      </button>

      {expanded && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted shrink-0">
            <span className="text-sm font-medium text-foreground truncate max-w-[80%]" title={title}>
              {title}
            </span>
            <div className="flex items-center gap-2">
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                title={t('common.openInNewTab')}
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium shadow-sm hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring"
                title={t('pdf.closeEsc')}
                aria-label={t('common.close')}
              >
                <X className="h-5 w-5" />
                <span>{t('common.close')}</span>
              </button>
            </div>
          </div>
          <iframe src={src} className="flex-1 w-full border-0" title={title} />
        </div>
      )}
    </div>
  );
}
