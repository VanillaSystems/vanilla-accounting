import { useState } from 'react';
import { createPortal } from 'react-dom';
import { lookupVatCode, vatCodeRateName, type VatCodeEntry } from '../../accounting/vat-codes.js';
import { accountingName, t } from '../i18n/index.js';
import { vatCodeHref } from '../lib/location.js';
import { cn } from '../lib/utils.js';

export const kindName = (e: VatCodeEntry) => t(`vatCodes.kind.${e.kind}.name`);
export const kindWhen = (e: VatCodeEntry) => t(`vatCodes.kind.${e.kind}.when`);
export const kindNotWhen = (e: VatCodeEntry) => t(`vatCodes.kind.${e.kind}.notWhen`);

/** "8.1% Normalsatz", "2.5% Reduzierter Satz (Satz bis 31.12.2023)", "0%"; empty without a rate. */
export function rateText(e: VatCodeEntry): string {
  if (e.rate === null) return '';
  const name = vatCodeRateName(e.rate);
  return [`${e.rate}%`, name && accountingName(name), e.superseded && `(${t('vatCodes.superseded')})`].filter(Boolean).join(' ');
}

const FIGURE = { turnover: 'vatCodes.figureTurnover', taxable: 'vatCodes.figureTaxable', tax: 'vatCodes.figureTax' } as const;

/** "200 (Umsatz), 303 (steuerbarer Umsatz)", or why the code feeds no Ziffer. */
export function zifferText(e: VatCodeEntry): string {
  if (e.ziffern === null) return t('vatCodes.notDeclared');
  if (e.ziffern.length === 0) return t('vatCodes.noZiffer');
  return e.ziffern.map((z) => `${z.ziffer} (${t(FIGURE[z.figure])})`).join(', ');
}

export const amountText = (e: VatCodeEntry) =>
  t(e.amountIs === 'tax' ? 'vatCodes.amountTax' : e.amountIs === 'net' ? 'vatCodes.amountNet' : 'vatCodes.amountGross');

/** The hover text of a code: what it is, its rate, where it goes in the return, and when it is used. */
export function vatCodeTitle(code: string): string {
  const found = lookupVatCode(code);
  if (!found) return `${code} · ${t('vatCodes.unknown')}`;
  const { entry, negative } = found;
  return [
    `${code} · ${kindName(entry)}${entry.rate ? `, ${rateText(entry)}` : ''}`,
    entry.ziffern?.length ? `→ ${t('vat.ziffer', { ziffer: zifferText(entry) })}` : zifferText(entry),
    entry.amountIs !== 'gross' && amountText(entry),
    negative && t('vatCodes.negative', { code: entry.code }),
    `${t('vatCodes.when')}: ${kindWhen(entry)}`,
  ].filter(Boolean).join('\n');
}

/** The hover card of a code, fixed to the viewport so a clipping table cell cannot cut it off. */
function VatCodeCard({ code, anchor }: { code: string; anchor: DOMRect }) {
  const found = lookupVatCode(code);
  const below = anchor.bottom + 260 < window.innerHeight;
  const style = {
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - 392)),
    ...(below ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
  };
  return createPortal(
    <div role="tooltip" style={style} className="fixed z-50 w-96 rounded-md border border-border bg-background p-3 text-xs text-foreground shadow-lg space-y-1.5 pointer-events-none" data-testid="vat-code-card">
      {!found ? <p><span className="font-mono font-semibold">{code}</span> · {t('vatCodes.unknown')}</p> : (
        <>
          <p>
            <span className="font-mono font-semibold">{code}</span> · <span className="font-medium">{kindName(found.entry)}</span>
            {found.entry.rate ? <span className="text-muted-foreground"> · {rateText(found.entry)}</span> : null}
          </p>
          <p className={cn(found.entry.ziffern === null && 'text-amber-700 dark:text-amber-300')}>
            {found.entry.ziffern?.length ? `→ ${t('vat.ziffer', { ziffer: zifferText(found.entry) })}` : zifferText(found.entry)}
          </p>
          {found.entry.amountIs !== 'gross' && <p className="text-muted-foreground">{amountText(found.entry)}</p>}
          {found.negative && <p className="text-muted-foreground">{t('vatCodes.negative', { code: found.entry.code })}</p>}
          <p><span className="font-semibold">{t('vatCodes.when')}:</span> {kindWhen(found.entry)}</p>
          <p className="text-muted-foreground">{t('vatCodes.clickHint')}</p>
        </>
      )}
    </div>,
    document.body,
  );
}

/**
 * A booked VAT code. Hovering or focusing it explains it; clicking opens it in the MWST tab's code
 * list with the period's entries that use it. `link` false (a cell that edits on double-click)
 * keeps only the explanation.
 */
export function VatCode({ code, link = true, className }: { code: string; link?: boolean; className?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const known = !!lookupVatCode(code)?.entry.ziffern;
  const props = {
    'aria-label': vatCodeTitle(code),
    'data-testid': 'vat-code',
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => setAnchor(e.currentTarget.getBoundingClientRect()),
    onMouseLeave: () => setAnchor(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => setAnchor(e.currentTarget.getBoundingClientRect()),
    onBlur: () => setAnchor(null),
    className: cn(
      'font-mono underline decoration-dotted underline-offset-2',
      known ? 'decoration-muted-foreground/50' : 'decoration-amber-500 text-amber-700 dark:text-amber-300',
      link && 'hover:text-foreground',
      className,
    ),
  };
  return (
    <>
      {link ? (
        <a {...props} href={vatCodeHref(code.replace(/^-/, ''))} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{code}</a>
      ) : (
        <span {...props}>{code}</span>
      )}
      {anchor && <VatCodeCard code={code} anchor={anchor} />}
    </>
  );
}
