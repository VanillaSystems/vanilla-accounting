/**
 * A VAT code's sign follows the money (persona round 7, r7h-22): a supplier's credit note or a
 * refund (bank debited, the expense credited) carries the minus code (-M81), a customer refund
 * (revenue debited) -V81. The plain code there would claim input tax on money received, or declare
 * turnover on money paid out. Every path a person or the KI books through refuses it, in words
 * the KI reads back (`codeSign`), so what it says is what is booked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks, PERSON, update, type Books } from '../src/books/store.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { addEntry, bookPayment, setEntry } from '../src/server/edits.js';
import { RequestError } from '../src/server/books.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

function demo(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'code-sign-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  return workspaceAt(dir);
}

const refused = (fn: () => unknown, expected: string, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof RequestError && e.status === 400 && JSON.stringify(e.refusal) === JSON.stringify({ code: 'codeSign', params: { code, expected } }) && /Minus/.test(e.message), `${code} on that line is refused, ${expected} named`);

const by = { kind: 'person' as const, at: '2026-10-16T08:00:00.000Z' };
const openEntry = (books: Books) => books.journalEntries.find((e) => e.date > (books.config.closedThrough ?? '') && e.origin !== 'manual' && e.vatCode === 'I81')!;

test('a supplier credit note (bank debited, the expense credited) takes -M81, never M81; an invoice (expense debited) takes M81, never -M81', () => {
  const books = loadBooks(demo());
  update(books, PERSON, (b) => {
    const e = openEntry(b);
    refused(() => setEntry(b, e.id, { accountDebit: '1021', accountCredit: '4000', vatCode: 'M81' }), '-M81', 'M81');
    refused(() => setEntry(b, e.id, { accountDebit: '4000', accountCredit: '1021', vatCode: '-M81' }), 'M81', '-M81');
    setEntry(b, e.id, { accountDebit: '1021', accountCredit: '4000', vatCode: '-M81' });
    assert.equal(b.journalEntries.find((x) => x.id === e.id)!.vatCode, '-M81');
    refused(() => setEntry(b, e.id, { vatCode: 'M81' }), '-M81', 'M81');
    setEntry(b, e.id, { description: 'Gutschrift GS-1207 zu FM-78230' });

    refused(() => addEntry(b, { date: e.date, accountDebit: '1021', accountCredit: '4000', amount: 408.6, vatCode: 'M81', description: 'Gutschrift', origin: 'manual', by }), '-M81', 'M81');
    refused(() => addEntry(b, { date: e.date, accountDebit: '1021', accountCredit: '6513', amount: 20, vatCode: 'I81', description: 'Rückerstattung', origin: 'manual', by }), '-I81', 'I81');
    const credit = addEntry(b, { date: e.date, accountDebit: '1021', accountCredit: '4000', amount: 408.6, vatCode: '-M81', description: 'Gutschrift', origin: 'manual', by });
    assert.equal(credit.vatCode, '-M81');
  });
});

test('a customer refund (revenue debited) takes -V81, never V81; a sale takes V81; codes without a direction of their own pass', () => {
  const books = loadBooks(demo());
  update(books, PERSON, (b) => {
    const e = openEntry(b);
    refused(() => addEntry(b, { date: e.date, accountDebit: '3400', accountCredit: '1021', amount: 50, vatCode: 'V81', description: 'Rückerstattung', origin: 'manual', by }), '-V81', 'V81');
    refused(() => addEntry(b, { date: e.date, accountDebit: '1021', accountCredit: '3400', amount: 50, vatCode: '-V81', description: 'Verkauf', origin: 'manual', by }), 'V81', '-V81');
    addEntry(b, { date: e.date, accountDebit: '3400', accountCredit: '1021', amount: 50, vatCode: '-V81', description: 'Rückerstattung', origin: 'manual', by });
    // A correction on one account, a VAT-only leg, Bezugsteuer, an export code: the sign is not the accounts' to say.
    addEntry(b, { date: e.date, accountDebit: '6513', accountCredit: '6513', amount: 10, vatCode: '-I81', description: 'nur die Steuer', origin: 'manual', by });
    addEntry(b, { date: e.date, accountDebit: '', accountCredit: '6513', amount: 3, vatCode: 'M81-2', description: 'Vorsteuer Shopify', origin: 'manual', by });
    addEntry(b, { date: e.date, accountDebit: '6570', accountCredit: '1021', amount: 30, vatCode: 'B81-1', description: 'Google Ads', origin: 'manual', by });
    addEntry(b, { date: e.date, accountDebit: '1021', accountCredit: '3400', amount: 30, vatCode: 'V0-E', description: 'Leistung im Ausland', origin: 'manual', by });
  });
});

test('a payment booked by hand: a line with the plain code on a refund is refused with the minus code named', () => {
  const ws = demo();
  const books = loadBooks(ws);
  const back = books.transactions.find((t) => t.direction === 'CRDT' && t.date > (books.config.closedThrough ?? '') && !books.journalEntries.some((e) => e.transactionRef === t.ref))
    ?? (() => { const t = { ref: 'GS-1', bank: 'Raiffeisen', date: '2026-10-08', amount: 408.6, currency: 'CHF', direction: 'CRDT' as const, description: 'Gutschrift GS-1207' }; books.transactions.push(t); return t; })();
  update(books, PERSON, (b) => {
    refused(() => bookPayment(b, back.ref, [{ accountDebit: '1021', accountCredit: '4000', amount: back.amount, vatCode: 'M81', description: 'Gutschrift' }], ws.bankAccounts, loadFxResolver()), '-M81', 'M81');
    assert.equal(b.journalEntries.some((e) => e.transactionRef === back.ref), false, 'nothing booked');
  });
});
