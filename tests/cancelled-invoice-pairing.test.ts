/**
 * P1.12 of the invoicing spec: after «Trotzdem stornieren» the payment stays unmatched. The cancelled
 * invoice's PDF, filed as its payment's receipt, is a receipt without a payment of its own for every
 * pairing path (the chain, the near pairs, the proposals, the intake's match: noPaymentFor).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/jurisdiction.js';
import { noPaymentFor } from '../src/intake/pair-chain.js';
import { saveInvoices } from '../src/invoices/store.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { issued } from './support/invoice-fixtures.js';
import type { Receipt } from '../src/types/index.js';
import type { Books } from '../src/books/store.js';

const sha = (c: string) => c.repeat(64);
const receipt = (id: string): Receipt => ({ id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-08-04T18:00:00.000Z', location: 'archived', kind: 'sales-record' } as Receipt);

test('a cancelled invoice\'s PDF is never a candidate for a payment; an open or paid one\'s is', () => {
  const ws = tempWorkspace('cancelled-pairing-');
  writeIndex(ws, {});
  const cancelled = issued('a', '2026-001', { pdf: { file: 'invoices/2026-001.pdf', sha256: sha('b') }, cancelled: { date: '2026-11-19', reason: 'doppelt' } });
  const open = issued('c', '2026-002', { pdf: { file: 'invoices/2026-002.pdf', sha256: sha('c') } });
  saveInvoices(ws, { schema: 3, customers: [], invoices: [cancelled, open], sent: [] } as never);
  const noPayment = noPaymentFor(ws)({ receipts: [], transactions: [], mappings: [], journalEntries: [], config: {} } as unknown as Books);
  assert.equal(noPayment(receipt(sha('b').slice(0, 16))), true, 'the cancelled invoice\'s PDF pairs with nothing');
  assert.equal(noPayment(receipt(sha('c').slice(0, 16))), false, 'an invoice still standing may still be paired');
});
