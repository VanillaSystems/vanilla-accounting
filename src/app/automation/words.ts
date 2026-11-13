/**
 * The words the dock's widget and Automatisierung's page say about the figures (#385 review): one
 * place, so a test reads what each place renders from the same books, and the two never drift apart.
 * `say` is t() in the app; a test passes a dictionary's own (src/app/i18n/core.ts formatIn).
 */
import type { HomeFigures } from './home.js';
import type { DockWidget, WidgetFigure } from './widget.js';

export type Say = (key: string, vars?: Record<string, string | number>) => string;

/** A figure as the bar shows it. */
export const figureText = (f: WidgetFigure): string => (f.key === 'withoutYou' ? `${f.pct} %` : String(f.n));
/** Its word under it in the bar. */
export const figureLabel = (say: Say, f: WidgetFigure): string => (f.key === 'withoutYou' ? say('dock.fig.withoutYou') : f.key === 'payments' ? say('dock.card.payments', { n: f.of ?? 0 }) : say(`dock.fig.${f.key}`, { n: f.n ?? 0 }));
/** Its words on the card and in the tip, which name the unit. */
export const cardLabel = (say: Say, f: WidgetFigure): string => (f.key === 'withoutYou' ? say('dock.fig.withoutYou') : f.key === 'payments' ? say('dock.card.payments', { n: f.of ?? 0 }) : say(`dock.card.${f.key}`, { n: f.n ?? 0 }));

/** The bar's figures in words, as its tip says them: «5 Belege gelesen · 3 Belege gebucht · 2 Aufgaben für dich». */
export const dockLine = (say: Say, w: Pick<DockWidget, 'stack'>): string => w.stack.map((f) => `${figureText(f)} ${cardLabel(say, f)}`).join(' · ');

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
