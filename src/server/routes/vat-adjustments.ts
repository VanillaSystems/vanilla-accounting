/**
 * The company's VAT page, its adjustments: config.vatAdjustments entered, changed and removed by the person
 * (src/accounting/vat-adjustments.ts). A line of a closed period, before or after the change, is
 * refused with 403 (golden rule 1).
 */
import { Router } from 'express';
import type { Books } from '../../books/store.js';
import { periodLock } from '../../books/store.js';
import { filing, vat } from '../../engines/index.js';
import { adjustmentDays, adjustmentId, parseAdjustment } from '../../accounting/vat-adjustments.js';
import type { AdjustmentRefusal } from '../../types/adjustment-refusal.js';
import type { VatAdjustment } from '../../types/index.js';
import { RequestError, assertOpen, patchBody, withBooks } from '../books.js';

export const router = Router();

const WORDS: Record<AdjustmentRefusal['params']['why'], string> = {
  period: 'period: eine Abrechnungsperiode wie 2026-Q3.',
  ziffer: 'ziffer: ein Vorsteuer-Feld der Abrechnung.',
  amount: 'amount: ein Betrag ungleich 0.',
  reason: 'reason: der Grund fehlt.',
  noEntry: 'entryIds: die eingereichte Buchung fehlt, auf die sich die Nachdeklaration bezieht.',
  entryMissing: 'entryIds: diese Buchung gibt es nicht.',
  entryNotFiled: 'entryIds: die Buchung liegt nicht in einer eingereichten Periode vor der Nachdeklaration.',
  id: 'id: Buchstaben, Zahlen, Punkt, Strich.',
  idTaken: 'id: diese Nachdeklaration gibt es schon.',
  gone: 'Diese Nachdeklaration gibt es nicht mehr.',
};

const refused = (r: AdjustmentRefusal) => new RequestError(r.params.why === 'gone' ? 404 : 400, `${WORDS[r.params.why]}${r.params.value ? ` (${r.params.value})` : ''}`, r);

const FIELDS = ['period', 'ziffer', 'amount', 'reason', 'entryIds'];

/** The line as sent: a closed period is refused first (403), whatever else is wrong with it. */
function checked(books: Books, body: Record<string, unknown>) {
  assertOpen(books, adjustmentDays({ period: String(body.period ?? '') }), 'vatAdjustment');
  const p = parseAdjustment(body, {
    entries: books.journalEntries,
    boxes: Object.keys(vat().form.inputTax),
    length: filing().length,
    isClosed: (d) => periodLock(books).isClosed(d),
  });
  if (!p.ok) throw refused(p.refusal);
  return p.draft;
}

function found(books: Books, id: string): VatAdjustment {
  const a = books.config.vatAdjustments?.find((x) => x.id === id);
  if (!a) throw refused({ code: 'vatAdjustment', params: { why: 'gone', value: id } });
  assertOpen(books, adjustmentDays(a), 'vatAdjustment');
  return a;
}

/** A new line; `id` only for the undo of a removal, which puts the line back as it was. */
router.post('/api/vat-adjustments', (req, res) => {
  withBooks(res, (books) => {
    const body = patchBody(req.body, [...FIELDS, 'id']);
    const draft = checked(books, body);
    const all = books.config.vatAdjustments ?? [];
    const id = adjustmentId(body.id, draft.period, all);
    if (!id.ok) throw refused(id.refusal);
    const line = { id: id.id, ...draft };
    books.config.vatAdjustments = [...all, line];
    return line;
  });
});

router.put('/api/vat-adjustments/:id', (req, res) => {
  withBooks(res, (books) => {
    const was = found(books, req.params.id);
    const line = { id: was.id, ...checked(books, patchBody(req.body, FIELDS)) };
    books.config.vatAdjustments = (books.config.vatAdjustments ?? []).map((a) => (a.id === was.id ? line : a));
    return line;
  });
});

router.delete('/api/vat-adjustments/:id', (req, res) => {
  withBooks(res, (books) => {
    const was = found(books, req.params.id);
    books.config.vatAdjustments = (books.config.vatAdjustments ?? []).filter((a) => a.id !== was.id);
    return was;
  });
});
