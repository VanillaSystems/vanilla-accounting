/**
 * The words the dock's widget and Automatisierung's page say about the figures (#385 review): one
 * place, so a test reads what each place renders from the same books, and the two never drift apart.
 * `say` is t() in the app; a test passes a dictionary's own (src/app/i18n/core.ts formatIn).
 */
import type { HomeFigures } from './home.js';
import type { DockWidget, WidgetFigure } from './widget.js';

export type Say = (key: string, vars?: Record<string, string | number>) => string;

/** A figure as the bar shows it: one number over its label. */
export const figureText = (f: WidgetFigure): string => (f.key === 'withoutYou' ? `${f.pct} %` : f.key === 'receipts' ? String(f.read) : String(f.n));
/** Its word under it in the bar, which names its unit (#398): «von 23 Zahlungen gebucht», «Aufgaben». */
export function figureLabel(say: Say, f: WidgetFigure): string {
  switch (f.key) {
    case 'withoutYou': return say('dock.fig.withoutYou');
    case 'payments': return f.of ? say('dock.card.payments', { n: f.of }) : say('dock.fig.paymentsNone');
    case 'receipts': return cardLine(say, f);
    case 'waiting': return say('dock.fig.waiting', { n: f.n });
  }
}
/** A figure as one line of words, number and unit together: the card's lines and the tip. */
export function cardLine(say: Say, f: WidgetFigure): string {
  switch (f.key) {
    case 'withoutYou': return `${f.pct} % ${say('dock.fig.withoutYou')}`;
    // A period without payments or receipts says so, never «0 von 0» (#398 review).
    case 'payments': return f.of ? say('dock.card.paymentsLine', { n: f.n, of: f.of }) : say('dock.card.paymentsNone');
    case 'receipts': return f.collected ? say('dock.card.receipts', { read: f.read, booked: f.booked }) : say('dock.card.receiptsNone');
    case 'waiting': return `${f.n} ${say('dock.card.waiting', { n: f.n })}`;
  }
}

/** The bar's figures in words, as its tip says them: «7 von 23 Zahlungen gebucht · 8 Aufgaben für dich». */
export const dockLine = (say: Say, w: Pick<DockWidget, 'stack'>): string => w.stack.map((f) => cardLine(say, f)).join(' · ');

/** The page's headline before its share: «8 Belege gesammelt, 4 davon gebucht». */
export const heroLine = (say: Say, f: HomeFigures): string => `${say('automation.home.hero.collected', { n: f.collected })}, ${say('automation.home.hero.booked', { n: f.booked })}`;

/** The line under the stages «Gelesen» and «Zugeordnet» of the page: what is not there yet, or that all are. */
export function stageLines(say: Say, f: HomeFigures, vatRegistered: boolean): { read: string; matched: string } {
  const unread = f.collected - f.read;
  const unmatched = Math.max(0, f.collected - f.matched);
  return {
    read: unread ? say('automation.home.s.unread', { n: unread }) : vatRegistered && f.read ? say('automation.home.s.vat', { n: f.withVat }) : f.read ? say('automation.home.s.allRead') : '',
    matched: unmatched ? say('automation.home.s.unmatched', { n: unmatched }) : f.matched ? say('automation.home.s.allMatched') : '',
  };
}
