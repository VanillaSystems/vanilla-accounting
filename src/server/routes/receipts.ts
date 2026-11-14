import { Router } from 'express';
import { renameSync, existsSync, createReadStream, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { RECEIPT_KINDS, type Receipt, type ReceiptKind, type ReceiptPatch } from '../../types/index.js';
import { deletionsOf, dropFromTrash, readTrashed, trashedFile, trashReceipt, type Trashed } from '../../books/receipt-trash.js';
import { entriesWithoutTheirReceipts, removeReceipt } from '../../accounting/classify-force.js';
import { parseVatFacts } from '../../accounting/vat-facts.js';
import { assertReceiptFieldsOpen, privatePayment, setReceipt, unbookedPayments } from '../edits.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { bookBillCorrections, loadClassifyContext } from '../../booking/classify.js';
import type { CorrectionWait } from '../../booking/vat-corrections.js';
import { withoutInputTax } from '../../engines/index.js';
import { bookHeldOrder, bookReportCorrection } from '../../intake/sales-report-import.js';
import type { PrivatePart } from '../../types/assistant.js';
import { bookAgain } from './automation.js';
import { ask } from '../../llm/ask.js';
import { buildVisionPrompt } from '../../llm/prompts.js';
import { visionVerdict } from '../../intake/unclear.js';
import { findFile } from '../../workspace/workspace.js';
import { fileHeaders } from '../../core/files.js';
import { orderPagesIn, providerIssuesIn, vatCorrectionsIn } from '../../intake/pair-chain.js';
import { forgetReadFacts } from '../../intake/vat.js';
import { isNoReceipt, referenced, refsOf } from '../../books/discard.js';
import { WS, receiptPath, assertOpen, receiptDates, refDates, readBooks, updateBooks, updateBooksWithEffects, withBooks, RequestError, patchBody, stringField } from '../books.js';

export const router = Router();

const refuse = (what: string): never => { throw new RequestError(400, `${what}.`); };

/** An empty description or remark clears it; null clears a date, an amount, a kind or the VAT facts. */
function parseReceiptPatch(body: unknown): ReceiptPatch {
  const b = patchBody(body, ['filename', 'date', 'amount', 'currency', 'description', 'remarks', 'kind', 'vat', 'vatBy']);
  const patch: ReceiptPatch = {};
  if ('filename' in b) {
    const filename = stringField(b, 'filename').trim();
    if (!filename || filename !== basename(filename) || filename.startsWith('.')) {
      throw new RequestError(400, 'filename muss ein Dateiname ohne Pfad sein.');
    }
    patch.filename = filename;
  }
  if ('date' in b) {
    if (b.date === null) patch.date = null;
    else {
      const date = stringField(b, 'date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RequestError(400, 'date muss JJJJ-MM-TT sein.');
      patch.date = date;
    }
  }
  if (b.amount === null) {
    if ('currency' in b) throw new RequestError(400, 'amount und currency nur zusammen.');
    patch.amount = null;
  } else {
    if ('amount' in b !== 'currency' in b) throw new RequestError(400, 'amount und currency nur zusammen.');
    if ('amount' in b) {
      if (typeof b.amount !== 'number' || !Number.isFinite(b.amount)) throw new RequestError(400, 'amount muss eine Zahl sein.');
      const currency = stringField(b, 'currency').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new RequestError(400, 'currency muss ein ISO-Code sein (z.B. CHF).');
      patch.amount = b.amount;
      patch.currency = currency;
    }
  }
  if ('description' in b) patch.description = stringField(b, 'description') || undefined;
  if ('remarks' in b) patch.remarks = stringField(b, 'remarks') || undefined;
  if ('kind' in b) {
    if (b.kind !== null && !RECEIPT_KINDS.includes(b.kind as ReceiptKind)) throw new RequestError(400, `kind muss eines von ${RECEIPT_KINDS.join(', ')} sein.`);
    patch.kind = b.kind as ReceiptKind | null;
  }
  if ('vat' in b) patch.vat = b.vat === null ? null : parseVatFacts(b.vat, refuse);
  if ('vatBy' in b) {
    if (b.vatBy !== null || !patch.vat) throw new RequestError(400, 'vatBy nur als null, mit vat.');
    patch.vatBy = null;
  }
  return patch;
}

/** The receipt with the patch applied: null removes a field, a kind (or none) is a person's. The VAT facts go through setReceipt. */
function patched(receipt: Receipt, { date, amount, kind, vat: _vat, vatBy: _vatBy, ...rest }: ReceiptPatch): Receipt {
  const out: Receipt = { ...receipt, ...rest };
  if (date !== undefined) out.date = date ?? undefined;
  if (amount !== undefined) out.amount = amount ?? undefined;
  if (kind !== undefined) {
    out.kind = kind ?? undefined;
    out.kindBy = 'human';
    out.kindRule = undefined;
    out.kindWhy = undefined;
  }
  return out;
}

/** A receipt the inbox's run still reads (staged, #218) remembers which facts the person entered: the run keeps them. */
function handSetOf(was: Receipt, patch: ReceiptPatch): Pick<Receipt, 'handSet'> {
  if (was.location !== 'staged') return {};
  const set = new Set(was.handSet);
  for (const k of ['date', 'amount', 'description'] as const) if (patch[k] !== undefined) set.add(k);
  return set.size ? { handSet: [...set] } : {};
}

router.get('/api/receipts/order-pages', (_req, res) => {
  res.json(orderPagesIn(WS, readBooks()));
});

router.get('/api/receipts/vat-corrections', (_req, res) => {
  res.json(vatCorrectionsIn(WS, readBooks()));
});

router.get('/api/receipts/provider-issues', (_req, res) => {
  res.json(providerIssuesIn(WS, readBooks()));
});

router.get('/api/receipts/:id', (req, res) => {
  const books = readBooks();
  const receipt = books.receipts.find((r) => r.id === req.params.id);
  if (!receipt) throw new RequestError(404, 'Receipt not found');

  const path = receiptPath(books, receipt);
  if (!existsSync(path)) throw new RequestError(404, 'File not found on disk');

  res.set(fileHeaders(receipt.filename)); // its own type (#523): a provider's CSV report, an image or a mail is no PDF
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(receipt.filename)}"`);
  createReadStream(path).pipe(res);
});

/** The receipt leaves the books with its links and the entries booked with it; its payments are booked again without it. */
router.delete('/api/receipts/:id', async (req, res) => {
  const { id } = req.params;
  const { trashed, pdfPath, again } = updateBooks((books) => {
    const receipt = books.receipts.find((r) => r.id === id);
    if (!receipt) throw new RequestError(404, 'Receipt not found');
    assertOpen(books, receiptDates(books, id), 'deleteReceipt');
    const pdfPath = receiptPath(books, receipt);
    const mappings = books.mappings.filter((m) => m.receiptId === id);
    const had = books.journalEntries;
    const again = removeReceipt(books, id);
    // A booking kept (a person's) no longer names the receipt that left the books (r4c-32).
    const named = books.journalEntries.filter((e) => e.receipts?.includes(id));
    for (const e of named) e.receipts = e.receipts!.filter((r) => r !== id);
    const trashed: Trashed = { deletedAt: new Date().toISOString(), receipt, mappings, file: relative(WS.paths.root, pdfPath), entries: had.filter((e) => !books.journalEntries.includes(e)), ...(named.length ? { named: named.map((e) => e.id) } : {}) };
    return { trashed, pdfPath, again };
  });
  const deletion = trashReceipt(WS, trashed, pdfPath);
  if (again.length) await bookAgain(trashed.receipt.filename);
  res.json({ ok: true, deletion });
});

/** The names a delete of several sends (`key`: ids, files): at least one, each a text. */
export function namesOf(body: unknown, key: string): string[] {
  const list = (body as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(list) || !list.length || list.some((x) => typeof x !== 'string' || !x)) throw new RequestError(400, `${key} muss eine Liste von Namen sein.`);
  return [...new Set(list as string[])];
}

/**
 * Files listed as «keine Belege» deleted for good (#228), all or none: each is one, belongs to no
 * closed period, and nothing in the books refers to it (else the refusal names what does). The
 * books lose them through the write door first, then their files leave the workspace folder.
 */
router.post('/api/receipts/discard', (req, res) => {
  const ids = namesOf(req.body, 'ids');
  const paths = updateBooks((books) => {
    const out = ids.map((id) => {
      const r = books.receipts.find((x) => x.id === id);
      if (!r) throw new RequestError(404, 'Diesen Beleg gibt es nicht mehr.', { code: 'gone', params: { what: 'receipt' } });
      assertOpen(books, [r.date || undefined, ...receiptDates(books, id)], 'discardFile');
      const refs = refsOf(books, r);
      if (referenced(refs)) {
        const what = [...refs.payments.map((p) => `Zahlung ${p}`), ...refs.entries.map((e) => `Buchung ${e}`), ...(refs.statements ? ['ein Kontoauszug'] : [])].join(', ');
        throw new RequestError(409, `${r.filename} bleibt: ${what} verweist darauf.`, { code: 'fileReferenced', params: { file: r.filename, ...refs } });
      }
      if (!isNoReceipt(r, 0)) throw new RequestError(400, `${r.filename} ist ein Beleg: löschen über «Beleg löschen».`);
      return receiptPath(books, r);
    });
    const gone = new Set(ids);
    books.receipts = books.receipts.filter((r) => !gone.has(r.id));
    for (const r of books.receipts) {
      if (!r.distinctFrom?.some((id) => gone.has(id))) continue;
      const rest = r.distinctFrom.filter((id) => !gone.has(id));
      if (rest.length) r.distinctFrom = rest; else delete r.distinctFrom;
    }
    return out;
  });
  for (const path of paths) rmSync(path, { force: true });
  res.json({ ok: true, deleted: ids.length });
});

/**
 * A deleted receipt back from the trash (its latest deletion, or the one named, which must be the
 * latest), with its links to payments that are still there. Those payments lose the entries booked
 * without it and get back the entries the deletion took, as they were; a payment a person booked
 * meanwhile keeps that booking. One left without an entry is booked again. Once back, the trash
 * holds nothing of it any more.
 */
router.post('/api/receipts/:id/restore', async (req, res) => {
  const { id } = req.params;
  const asked = (req.body as { deletion?: unknown } | undefined)?.deletion;
  const all = deletionsOf(WS, id);
  const deletion = typeof asked === 'string' ? asked : all.at(-1);
  if (!deletion || !all.includes(deletion)) throw new RequestError(404, 'Dieser Beleg liegt nicht mehr im Papierkorb.', { code: 'notInTrash' });
  if (deletion !== all.at(-1)) throw new RequestError(409, 'Dieser Beleg wurde später noch einmal gelöscht. «Rückgängig» der letzten Löschung holt ihn zurück.', { code: 'deletedAgain' });
  const t = readTrashed(WS, id, deletion);
  const from = trashedFile(WS, id, deletion, t);
  const to = join(WS.paths.root, t.file);
  const again = updateBooks((books) => {
    if (books.receipts.some((r) => r.id === id)) throw new RequestError(409, 'Dieser Beleg ist schon in den Büchern.', { code: 'alreadyBack' });
    if (existsSync(to) || findFile(WS.paths, 'receipts', t.receipt.filename)) {
      throw new RequestError(409, `Datei ${t.receipt.filename} existiert bereits.`, { code: 'fileExists', params: { filename: t.receipt.filename } });
    }
    const refs = new Set(books.transactions.map((x) => x.ref));
    const links = t.mappings.filter((m) => refs.has(m.transactionRef));
    assertOpen(books, links.flatMap((m) => refDates(books, m.transactionRef)), 'editReceipt');
    books.receipts.push(t.receipt);
    books.mappings.push(...links);
    const linked = new Set(links.map((m) => m.transactionRef));
    const stale = new Set(entriesWithoutTheirReceipts(books.journalEntries, books.mappings, linked, books.config.closedThrough));
    books.journalEntries = books.journalEntries.filter((e) => !stale.has(e));
    const bare = new Set([...linked].filter((ref) => !books.journalEntries.some((e) => e.transactionRef === ref)));
    books.journalEntries.push(...(t.entries ?? []).filter((e) => bare.has(e.transactionRef)));
    for (const e of books.journalEntries) if (t.named?.includes(e.id) && e.receipts && !e.receipts.includes(id)) e.receipts = [...e.receipts, id];
    return [...linked].some((ref) => !books.journalEntries.some((e) => e.transactionRef === ref));
  });
  if (existsSync(from)) { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); }
  dropFromTrash(WS, id);
  if (again) await bookAgain(t.receipt.filename);
  res.json({ ok: true, receipt: t.receipt });
});

/**
 * OCR of a receipt PDF by the model. Only called when the user explicitly approves via the UI.
 * The model reads the PDF first; the text is then saved to books loaded after it answered, and the
 * VAT facts read off the old text are forgotten, so the next run reads them off the new one (#284).
 */
router.post('/api/vision/extract', async (req, res) => {
  const { receiptId } = req.body as { receiptId: string };
  const books = readBooks();
  const receipt = books.receipts.find((r) => r.id === receiptId);
  if (!receipt) throw new RequestError(404, 'Receipt not found');
  assertOpen(books, receiptDates(books, receiptId), 'editReceipt');

  const pdfPath = receiptPath(books, receipt);
  if (!existsSync(pdfPath)) throw new RequestError(404, 'PDF file not found on disk');

  // Only read: a person asks for this receipt's text, so the prompt never asks whether it is one (#361).
  const text = await ask(buildVisionPrompt(pdfPath), {
    step: 'receipt-vision', timeoutMs: 120_000, attachments: [pdfPath],
  });
  // A «Kein Beleg: …» is never kept as a receipt's text: nothing is written.
  if (visionVerdict(text)) throw new RequestError(422, 'Die KI hat auf der Datei keinen Text eines Belegs gefunden. Datum, Betrag und MWST selbst eintippen.');
  withBooks(res, (books) => {
    const receipt = books.receipts.find((r) => r.id === receiptId);
    if (!receipt) throw new RequestError(404, 'Receipt not found');
    assertOpen(books, receiptDates(books, receiptId), 'editReceipt');
    receipt.extractedText = text;
    receipt.extractionMethod = 'claude';
    receipt.needsVisionReview = undefined;
    forgetReadFacts(receipt);
    return { ok: true, extractedText: text };
  });
});

/** The body of «Privat oder bar bezahlt»: all optional; the business part's amount in the receipt's currency, what it was, its VAT rate line, the booking by hand it replaces. */
function privatePartOf(raw: unknown): PrivatePart {
  const b = patchBody(raw ?? {}, ['amount', 'part', 'rate', 'replace', 'by']);
  const num = (k: 'amount' | 'rate') => {
    if (b[k] === undefined || b[k] === null) return {};
    if (typeof b[k] !== 'number') throw new RequestError(400, `${k} muss eine Zahl sein.`);
    return { [k]: b[k] as number };
  };
  const text = (k: 'part' | 'replace' | 'by') => (typeof b[k] === 'string' && (b[k] as string).trim() ? { [k]: (b[k] as string).trim().slice(0, 80) } : {});
  return { ...num('amount'), ...num('rate'), ...text('part'), ...text('replace'), ...text('by') };
}

/**
 * The money account of the employee who paid (#216): the firm's account of that ledger number with
 * the role `employee` (Firma › Geldkonten; the form asks for it once and keeps it). Its label is
 * the payment's bank, so the booking goes on that person's account, never on one the app made up.
 */
function employeeBank(account: string): { label: string; currency: string } {
  const a = WS.bankAccounts.find((x) => x.account === account && x.role === 'employee');
  if (!a) throw new RequestError(400, `Konto ${account} ist kein Konto einer Mitarbeiterin oder eines Mitarbeiters der Firma.`, { code: 'notEmployee', params: { account } });
  return { label: a.bank, currency: a.currency };
}

/** «Privat oder bar bezahlt» (src/server/edits.ts privatePayment): the owner's payment of the receipt or of its business part, linked; the inbox run books it. A receipt of a filed period: dated the first open day, `corrects` names the period (r8k-10). */
router.post('/api/receipts/:id/private-payment', async (req, res) => {
  const { id } = req.params;
  const ask = privatePartOf(req.body);
  const bank = ask.by === undefined ? undefined : employeeBank(ask.by);
  const { made, file } = updateBooks((books) => ({ made: privatePayment(books, id, ask, loadFxResolver(), bank), file: books.receipts.find((r) => r.id === id)!.filename }));
  await bookAgain(file);
  res.json({ ok: true, ...made });
});

/**
 * «Als Korrektur buchen» (#231, golden rule 1): a refund paid in a filed period that the sales report
 * `:id` offers as a correction, booked by the person in the open period with `corrects` naming the
 * filing period of its day (src/intake/sales-report-import.ts bookReportCorrection). `on`: the open day
 * to book it on, the first open day when absent; a closed one is refused before anything else.
 */
router.post('/api/receipts/:id/report-correction', (req, res) => {
  const b = patchBody(req.body, ['order', 'date', 'on']);
  const order = stringField(b, 'order').trim();
  const date = stringField(b, 'date');
  const on = b.on === undefined ? undefined : stringField(b, 'on');
  if (!order || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (on !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(on))) throw new RequestError(400, 'order, date (JJJJ-MM-TT) und optional on (JJJJ-MM-TT) erwartet.');
  withBooks(res, (books) => {
    if (on !== undefined) assertOpen(books, [on], 'newEntry');
    const done = bookReportCorrection(WS, books, req.params.id, order, date, { ...(on !== undefined ? { on } : {}) });
    if (!done.ok) throw new RequestError(done.why === 'gone' ? 404 : 409, done.why === 'gone' ? 'Diesen Verkaufsbericht gibt es nicht (mehr).' : 'Diese Rückerstattung bietet der Bericht nicht (mehr) als Korrektur an.', { code: 'reportCorrection', params: { why: done.why } });
    assertOpen(books, done.entries.map((e) => e.date), 'newEntry');
    return { ok: true, entries: done.entries };
  });
});

/**
 * «Aufteilen und buchen» (#405): an order the sales report `:id` holds, booked by the person in parts by rate
 * (src/intake/sales-report-import.ts bookHeldOrder), the parts adding up to its gross; its day must be open.
 */
router.post('/api/receipts/:id/held-order', (req, res) => {
  const b = patchBody(req.body, ['order', 'parts']);
  const order = stringField(b, 'order').trim();
  const parts = Array.isArray(b.parts) ? b.parts.map((x: unknown) => (x && typeof x === 'object' ? { amount: Number((x as Record<string, unknown>).amount), rate: Number((x as Record<string, unknown>).rate) } : { amount: NaN, rate: NaN })) : [];
  if (!order || !parts.length || parts.some((x: { amount: number; rate: number }) => !Number.isFinite(x.amount) || !Number.isFinite(x.rate))) throw new RequestError(400, 'order und parts ([{ amount, rate }]) erwartet.');
  withBooks(res, (books) => {
    const held = books.receipts.find((r) => r.id === req.params.id)?.report?.held?.find((h) => h.order === order);
    if (held?.date) assertOpen(books, [held.date], 'newEntry');
    const done = bookHeldOrder(WS, books, req.params.id, order, parts);
    if (!done.ok) throw new RequestError(done.why === 'gone' ? 404 : done.why === 'notHeld' || done.why === 'notRate' || done.why === 'beforeReach' ? 409 : 400, `Bestellung ${order} nicht gebucht (${done.why}).`, { code: 'heldOrder', params: { why: done.why } });
    assertOpen(books, done.entries.map((e) => e.date), 'newEntry');
    return { ok: true, entries: done.entries };
  });
});

/**
 * «Vorsteuer buchen» (#458): the input tax a bill of a VAT-only correction shows (a provider's Payments Invoice), booked
 * as the booking step books it (src/booking/vat-corrections.ts), at once, on the day and with the facts the receipt has,
 * a person's typed ones among them. Refused with why when code would not book it.
 */
router.post('/api/receipts/:id/vat-correction', (req, res) => {
  withBooks(res, (books) => {
    const r = books.receipts.find((x) => x.id === req.params.id);
    if (!r) throw new RequestError(404, 'Diesen Beleg gibt es nicht (mehr).');
    const refuse = (why: CorrectionWait | 'none' | 'noDate' | 'noInputTax') => new RequestError(409, `Vorsteuer nicht gebucht (${why}).`, { code: 'vatCorrection', params: { why } });
    // A firm without input tax (the net tax rate method, not registered) deducts none: Belege offers no button there.
    if (withoutInputTax()) throw refuse('noInputTax');
    if (!r.date) throw refuse('noDate');
    assertOpen(books, [r.date], 'newEntry');
    // Her click is newer than a booking she took apart from the bill once (notPaidBy): that mark keeps the run from booking it, not her.
    const apart = r.notPaidBy;
    delete r.notPaidBy;
    const done = bookBillCorrections(books, loadClassifyContext(WS), loadFxResolver(), r.id);
    if (apart) r.notPaidBy = apart;
    const ref = done.booked[0]?.ref ?? done.linked[0]?.ref;
    if (!ref) throw refuse(done.waiting[0]?.why ?? 'none');
    return { ok: true, ref, booked: done.booked.length > 0, entries: books.journalEntries.filter((e) => e.transactionRef === ref).map((e) => e.id) };
  });
});

// One edit of a receipt is one write: every field is validated before anything changes, and
// a file rename is undone if the books are not saved, so a receipt is never half-edited. New VAT
// facts take the classifier's bookings of the receipt's payments away; the inbox run books them again.
router.patch('/api/receipts/:id', async (req, res) => {
  const patch = parseReceiptPatch(req.body);
  const { id } = req.params;
  let undoRename = () => {};
  let again: string[] = [];
  let receipt: Receipt;
  try {
    receipt = updateBooksWithEffects((books) => {
      const idx = books.receipts.findIndex((r) => r.id === id);
      if (idx === -1) throw new RequestError(404, 'Receipt not found');
      assertReceiptFieldsOpen(books, id, Object.keys(patch));

      const was = books.receipts[idx];
      if (patch.filename !== undefined) undoRename = renameReceiptFile(receiptPath(books, was), patch.filename);
      books.receipts[idx] = { ...patched(was, patch), ...handSetOf(was, patch) };
      if (patch.vat !== undefined) {
        setReceipt(books, id, { vat: patch.vat ?? { lineItems: undefined }, ...(patch.vat === null || patch.vatBy === null ? { vatBy: null } : {}) });
        again = unbookedPayments(books, [id]);
      }
      return books.receipts[idx];
    });
  } catch (err) {
    undoRename();
    throw err;
  }
  if (again.length) await bookAgain(receipt.filename);
  res.json({ ok: true, receipt });
});

/** Renames the receipt's PDF on disk (a missing file is left alone) and returns the undo. A name another year folder holds is a clash too. */
function renameReceiptFile(from: string, filename: string): () => void {
  if (filename === basename(from)) return () => {};
  const to = join(dirname(from), filename);
  const elsewhere = dirname(from) !== WS.paths.inbox && findFile(WS.paths, 'receipts', filename);
  // Case-only renames hit the same file on a case-insensitive disk; that is not a clash.
  if ((existsSync(to) || elsewhere) && filename.toLowerCase() !== basename(from).toLowerCase()) {
    throw new RequestError(409, `Datei ${filename} existiert bereits.`, { code: 'fileExists', params: { filename } });
  }
  if (!existsSync(from)) return () => {};
  renameSync(from, to);
  return () => renameSync(to, from);
}
