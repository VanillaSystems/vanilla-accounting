/**
 * A receipt's VAT facts as a person sets them (by hand in Belege, or by asking the AI sidebar),
 * checked where they come in, and the receipt they make: a person's facts (vatBy 'human'), which
 * the VAT step (src/intake/vat.ts) never overwrites.
 */
import { vat } from '../engines/index.js';
import type { Receipt, VatFacts, VatRateGroup } from '../types/index.js';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The facts in `v`, or `fail` with what is wrong. Swiss VAT is shown at one of the jurisdiction's
 * own rates (also a superseded one); a receipt may show other rates beside it (0 %, a foreign VAT),
 * as the AI reads them.
 */
export function parseVatFacts(v: unknown, fail: (what: string) => never): VatFacts {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('vat fehlt');
  const o = v as Record<string, unknown>;
  // A receipt states facts; the code is the booking's, derived from them and its accounts (issue #64).
  if ('vatCode' in o || 'code' in o) fail('vat: ein Steuercode gehört nicht zu den Fakten des Belegs, nur hasSwissVat, vatSummary und vatId');
  if (typeof o.hasSwissVat !== 'boolean') fail('vat.hasSwissVat muss true oder false sein');
  const raw = o.vatSummary ?? [];
  if (!Array.isArray(raw)) fail('vat.vatSummary muss eine Liste sein');
  const groups = raw.map((g): VatRateGroup => {
    const x = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
    if (!finite(x.ratePercent) || x.ratePercent < 0 || x.ratePercent >= 100) fail(`vat.vatSummary: ${String(x.ratePercent)} ist kein Steuersatz`);
    if (!finite(x.vat) || x.vat < 0) fail('vat.vatSummary: vat muss ein Betrag sein');
    for (const k of ['net', 'gross'] as const) if (x[k] !== undefined && !finite(x[k])) fail(`vat.vatSummary: ${k} muss ein Betrag sein`);
    return { ratePercent: x.ratePercent, vat: x.vat, ...(x.net !== undefined && { net: x.net as number }), ...(x.gross !== undefined && { gross: x.gross as number }) };
  });
  if (new Set(groups.map((g) => g.ratePercent)).size < groups.length) fail('vat.vatSummary: jeder Satz einmal');
  if (o.hasSwissVat && !groups.some((g) => vat().isDomesticRate(g.ratePercent))) fail('vat.vatSummary: mindestens ein Satz des Landes');
  if (o.vatId !== undefined && typeof o.vatId !== 'string') fail('vat.vatId muss Text sein');
  const vatId = (o.vatId as string | undefined)?.trim();
  return { hasSwissVat: o.hasSwissVat, vatSummary: groups, ...(vatId && { vatId }) };
}

type Held = Pick<Receipt, 'hasSwissVat' | 'vatSummary' | 'vatId' | 'lineItems' | 'vatBy'>;

/** What a receipt holds of its VAT facts: what an undo puts back. */
export const heldFacts = (r: Receipt): Held => ({ hasSwissVat: r.hasSwissVat, vatSummary: r.vatSummary, vatId: r.vatId, lineItems: r.lineItems, vatBy: r.vatBy });

const same = (a: Held, b: Held) =>
  JSON.stringify([a.hasSwissVat, a.vatSummary ?? [], a.vatId ?? '']) === JSON.stringify([b.hasSwissVat, b.vatSummary ?? [], b.vatId ?? '']);

/**
 * Sets the facts on `r`, as a person's unless `by` is null (an undo putting back what the AI read).
 * Line items the AI read stay while every one of their rates is still a rate of the receipt; an
 * undo brings back its own; without facts the receipt is unread again. Returns whether the facts
 * differ from what the receipt had.
 */
export function setVatFacts(r: Receipt, facts: Omit<Held, 'vatBy'>, by: 'human' | null): boolean {
  const was = heldFacts(r);
  const rates = new Set((facts.vatSummary ?? []).map((g) => g.ratePercent));
  const lineItems = 'lineItems' in facts ? facts.lineItems
    : r.lineItems?.every((l) => l.ratePercent === undefined || rates.has(l.ratePercent)) ? r.lineItems : undefined;
  for (const k of ['hasSwissVat', 'vatSummary', 'vatId', 'lineItems', 'vatBy'] as const) delete r[k];
  // A person's facts end the count of failed reads (#450); without facts the step reads it afresh.
  delete r.vatReadFailures;
  // No facts at all: unread, so the VAT step reads the receipt again.
  if (facts.hasSwissVat === undefined) delete r.vatExtractedAt;
  Object.assign(r, Object.fromEntries(Object.entries({ ...facts, lineItems, vatBy: by ?? undefined }).filter(([, v]) => v !== undefined)));
  return !same(was, r);
}
