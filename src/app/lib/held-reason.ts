/**
 * The words of why a provider's report holds an order (`drop.held.<why>`). A reason this build has no text for (one a newer
 * build stored in `report.held`) reads as a plain «waits for you» sentence, never a page that throws. `has` and `say` are the
 * dictionary's (isKey and tWith of src/app/i18n/index.ts), passed in so this stays testable without the bundler.
 */
export interface HeldOrder { order: string; why: string; rates?: number; most?: number }

export function heldReasonText(h: HeldOrder, has: (key: string) => boolean, say: (key: string, vars: Record<string, string | number>) => string): string {
  const key = `drop.held.${h.why}`;
  return has(key) ? say(key, { order: h.order, rates: h.rates ?? '', most: h.most ?? '' }) : say('drop.held.other', { order: h.order });
}
