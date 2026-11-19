/** Issued documents and sent-log entries for tests of Verkauf's lists, where the demo has too few states. */
import type { Invoice, Issued, SentDocument } from '../../src/invoices/model.js';

export const issued = (id: string, number: string, over: Partial<Issued> = {}): Issued => ({
  id, createdAt: '2026-10-01T08:00:00Z', origin: 'manual', deleted: false, status: 'issued', kind: 'invoice', number, issuedAt: '2026-10-01T08:00:00Z',
  customerId: 'c1', date: '2026-10-01', dueDate: '2026-10-31', currency: 'CHF', language: 'de', reference: `RF18${number}`,
  lines: [{ text: 'Beratung', quantity: 1, price: 1000, vatRate: 0 }],
  customer: { name: 'Kunde AG', address: { postcode: '8000', town: 'Zürich', country: 'CH' }, language: 'de', paymentTermsDays: 30, email: 'ap@kunde.example' },
  sender: { name: 'Firma', address: { postcode: '8000', town: 'Zürich', country: 'CH' }, uid: 'CHE-123.456.789', payTo: { account: '1020', iban: 'CH00' } },
  layout: {} as Issued['layout'], pdf: { file: `invoices/${number}.pdf`, sha256: 'a'.repeat(64) }, payments: [], reminders: [], comments: [],
  ...over,
});

export const sentDoc = (id: string, inv: Invoice, over: Partial<SentDocument> = {}): SentDocument => ({
  id, createdAt: '2026-10-02T08:00:00Z', origin: 'manual', deleted: false, invoiceId: inv.id, kind: 'invoice', title: `Rechnung ${inv.status === 'issued' ? inv.number : ''}`,
  file: 'x.pdf', sha256: `${id}`.padEnd(64, '0'), sentAt: '2026-10-02T09:14:00Z', to: 'ap@kunde.example', channel: 'email', messageId: `<${id}@mail>`, ...over,
});

