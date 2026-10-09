import { ExternalLink } from 'lucide-react';
import { cn } from '../lib/utils.js';

interface OpenInTabLinkProps {
  href: string;
  className?: string;
  size?: 'xs' | 'sm';
  title?: string;
}

/** Small "open detail view in new tab" icon link. Stops click propagation so it
 *  doesn't trigger a parent row's in-place select handler. */
export function OpenInTabLink({ href, className, size = 'sm', title = 'In neuem Tab öffnen' }: OpenInTabLinkProps) {
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
      <ExternalLink className={size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </a>
  );
}
