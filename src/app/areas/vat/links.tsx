/** Links from MWST and Bilanz & ER to the objects their figures are made of: entries and VAT codes. */
import type { MouseEvent, ReactNode } from 'react';
import type { JournalEntry } from '../../../types/index.js';
import { lookupVatCode } from '../../../accounting/vat-codes.js';
import { localToday, parsePeriod, periodContaining, type Period } from '../../../accounting/periods.js';
import { hrefOf } from '../../shell/history.js';
import type { Location } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';

/** A real link (copy, open in a new tab) that a plain click follows inside the app. */
export function Go({ to, nav, className, title, vat, children }: { to: Location; nav: Nav; className?: string; title?: string; vat?: string; children: ReactNode }) {
  const follow = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    nav.go(to);
  };
  return <a href={hrefOf(to)} className={className} title={title} data-vat={vat} onClick={follow}>{children}</a>;
}

/** An entry, in the current period when it holds the entry's date (urls.md rule 1). */
export const entryAt = (e: JournalEntry, current: Period): Location =>
  ({ route: { area: 'journal', id: e.id }, query: { period: parsePeriod(periodContaining(e.date, current), localToday()) ?? undefined } });

const unsigned = (code: string) => code.replace(/^-/, '');

/** What a code is, in one line: "Vorsteuer auf Investitionen und übrigen Betriebsaufwand". */
export function codeName(code: string): string {
  const found = lookupVatCode(code);
  return found ? t(`vatCodes.kind.${found.entry.kind}.name`) : t('vatCodes.unknown');
}

/** A code that explains itself on hover (the VAT card) and opens its catalogue page. */
export function CodeLink({ code, nav }: { code: string; nav: Nav }) {
  return (
    <Go to={{ route: { area: 'codes', code: unsigned(code) }, query: {} }} nav={nav} className="vlink mono" vat={code}>
      {code}
    </Go>
  );
}
