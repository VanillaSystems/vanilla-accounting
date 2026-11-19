/** Issued documents and sent-log entries for tests of Verkauf's lists, where the demo has too few states. */
import { contactRecord } from '../../src/invoices/dated-values.js';
import type { Contact, CustomerFields, Envelope, Invoice, Issued, SentDocument } from '../../src/invoices/model.js';
import { contactOfCustomer } from '../../src/invoices/contacts.js';

/** A customer as phase 1 wrote one, with its envelope: what `issue` freezes, and as a contact through `asContact`. */
export type Customer = CustomerFields & Envelope;
/** The firm contact the invoices.json step 3 → 4 makes of a customer, under the same id. */
export const asContact = (c: Customer): Contact => ({ id: c.id, createdAt: c.createdAt, origin: c.origin, deleted: c.deleted, ...contactRecord(contactOfCustomer(c), undefined, '', '') });

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


/** The body of POST /api/contacts for a customer as phase 1 posted it to /api/customers: a firm, its address the billing address. */
export const contactBody = (c: Partial<CustomerFields>): Record<string, unknown> => ({
  type: 'firm', name: c.name, language: c.language ?? 'de',
  addresses: c.address ? [{ ...c.address, ...(c.attn ? { attn: c.attn } : {}), billing: true }] : [],
  emails: c.email ? [c.email] : [],
  ...(c.vatId !== undefined ? { vatId: c.vatId } : {}),
  ...(c.paymentTermsDays !== undefined ? { paymentDays: c.paymentTermsDays } : {}),
});
