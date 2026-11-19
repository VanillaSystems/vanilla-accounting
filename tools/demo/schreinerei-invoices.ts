/**
 * What Schreinerei Beispiel GmbH invoices in the app from August 2026: a kitchen for a family and
 * built-in wardrobes for a housing developer. The joinery quotes its customers prices including
 * VAT, so its invoices are priced gross; the paper shows the statutory rate (Art. 26 MWSTG), the
 * books the approved net tax rate. The kitchen's appliances are bought in and resold: that is the
 * firm's second approved activity (trade), whose position books F2 at its own rate (#504). The
 * kitchen is paid by QR reference; the wardrobes are open.
 */
import type { DemoInvoicing } from './kit.js';

export const SCHREINEREI_INVOICING: DemoInvoicing = {
  address: { street: 'Werkstrasse', number: '12', postcode: '9000', town: 'St. Gallen', country: 'CH' },
  qrr: true,
  manifest: `invoicing:
  payTo:
    CHF: { account: "1020", qrIban: CH39 3080 8000 0000 0000 3 }
  revenueAccount: "3400"
  paymentTermsDays: 30
  numbering:
    invoice: { format: "{JJJJ}-{NNN}", restartYearly: true }
    credit-note: { format: "{JJJJ}-{NNN}", restartYearly: true }
  prices: { invoice: gross, credit-note: gross }
  paymentTerms:
    - { id: net30, name: "30 Tage netto", days: 30 }
  texts:
    de: { closing: "Zahlbar innert {days} Tagen.\\nFreundliche Grüsse, Reto Beispiel" }
`,
  customers: {
    familie: {
      name: 'Familie Huber-Beispiel', address: { street: 'Obere Gasse', number: '17', postcode: '9008', town: 'St. Gallen', country: 'CH' },
      language: 'de', email: 'huber-beispiel@mail.example', paymentTermsDays: 30,
    },
    wohnbau: {
      name: 'Muster Wohnbau AG', attn: 'Bauleitung, z. H. Frau Muster', address: { street: 'Rorschacher Strasse', number: '150', postcode: '9006', town: 'St. Gallen', country: 'CH' },
      language: 'de', vatId: 'CHE-579.135.791 MWST', email: 'rechnungen@muster-wohnbau.example', paymentTermsDays: 30,
    },
  },
  steps: [
    { do: 'issue', key: 'kueche', customer: 'familie', at: '2026-08-14T16:20:00.000Z', date: '2026-08-14', subject: 'Küche in Nussbaum', supplied: { from: '2026-08-03', to: '2026-08-12' }, prices: 'gross',
      lines: [
        { kind: 'text', text: 'Küche', style: 'title' },
        { text: 'Küchenfronten Nussbaum massiv, Herstellung', quantity: 14, unit: 'pcs', price: 420, vatRate: 8.1 },
        { text: 'Korpusse und Arbeitsplatte, Montage', quantity: 32, unit: 'h', price: 98, vatRate: 8.1 },
        { kind: 'subtotal', text: 'Total Küche' },
        { kind: 'text', text: 'Geräte', style: 'title' },
        { text: 'Einbaugeräte (Backofen, Kochfeld, Geschirrspüler), Lieferung', quantity: 1, unit: 'flat', price: 4380, vatRate: 8.1, activity: 2 },
        { kind: 'subtotal', text: 'Total Geräte' },
        { kind: 'discount', text: 'Rabatt 3 %', percent: 3 },
      ],
      paid: { date: '2026-09-11', bank: 'raiffeisen' } },
    { do: 'issue', key: 'schraenke', customer: 'wohnbau', at: '2026-09-24T10:00:00.000Z', date: '2026-09-24', subject: 'Einbauschränke Überbauung Rosenberg', prices: 'gross',
      lines: [
        { text: 'Einbauschrank Eiche furniert, 2,4 m', quantity: 8, unit: 'pcs', price: 1850, vatRate: 8.1 },
        { text: 'Montage', quantity: 24, unit: 'h', price: 98, vatRate: 8.1 },
      ] },
  ],
  // Phase 2 (spec 5 «Phase 2»): a kitchen quoted to another family, accepted, and its Auftrag (printed as Auftragsbestätigung).
  sales: {
    contacts: {
      rossi: {
        type: 'firm', name: 'Familie Beispiel-Rossi', language: 'de', emails: ['beispiel-rossi@mail.example'], paymentDays: 30, persons: [],
        addresses: [{ id: 'a-1', street: 'Bühlstrasse', number: '4', postcode: '9010', town: 'St. Gallen', country: 'CH', billing: true }],
      },
    },
    steps: [
      { do: 'issue', key: 'an-kueche', kind: 'quote', customer: 'rossi', at: '2026-10-05T15:30:00.000Z', date: '2026-10-05', validUntil: '2026-11-04', subject: 'Küche in Eiche', prices: 'gross',
        lines: [
          { kind: 'text', text: 'Küche', style: 'title' },
          { text: 'Küchenfronten Eiche massiv, Herstellung', quantity: 12, unit: 'pcs', price: 390, vatRate: 8.1 },
          { text: 'Korpusse und Arbeitsplatte, Montage', quantity: 28, unit: 'h', price: 98, vatRate: 8.1 },
          { text: 'Einbaugeräte (Backofen, Kochfeld, Geschirrspüler), Lieferung', quantity: 1, unit: 'flat', price: 3950, vatRate: 8.1, activity: 2 },
        ] },
      { do: 'answer', of: 'an-kueche', at: '2026-10-12T17:00:00.000Z', answer: 'accepted' },
      { do: 'convert', key: 'au-kueche', of: 'an-kueche', to: 'sales-order', at: '2026-10-13T08:00:00.000Z', lines: [{ line: 1, quantity: 12 }, { line: 2, quantity: 28 }, { line: 3, quantity: 1 }] },
    ],
  },
};
