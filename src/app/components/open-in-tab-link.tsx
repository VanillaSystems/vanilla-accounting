import { ArrowLeftRight, BookText, ExternalLink, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { entryHref, txHref } from '../lib/location.js';
import type { Period } from '../../accounting/periods.js';

interface OpenInTabLinkProps {
  href: string;
  className?: string;
  size?: 'xs' | 'sm';
  title?: string;
  /** What the link opens, when not a generic page. */
  icon?: LucideIcon;
}

/** Small "open detail view in new tab" icon link. Stops click propagation so it
 *  doesn't trigger a parent row's in-place select handler. */
export function OpenInTabLink({ href, className, size = 'sm', title = t('common.openInNewTab'), icon: Icon = ExternalLink }: OpenInTabLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={title}
      className={cn(
        'shrink-0 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground',
        size === 'xs' ? 'p-0.5' : 'p-1',
        className,
      )}
    >
      <Icon className={size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </a>
  );
}

/** A journal entry's two detail views: the entry in Buchungen, its bank transaction in Transaktionen. */
export function EntryLinks({ entry, period }: { entry: { id: string; date?: string; transactionRef?: string }; period?: Period }) {
  return (
    <span className="inline-flex items-center gap-0.5 print:hidden" data-testid="entry-links">
      <OpenInTabLink href={entryHref(entry.id, entry.date, period)} size="xs" title={t('links.openEntry')} icon={BookText} />
      {entry.transactionRef && (
        <OpenInTabLink href={txHref(entry.transactionRef, entry.date, period)} size="xs" title={t('links.openTransaction')} icon={ArrowLeftRight} />
      )}
    </span>
  );
}
