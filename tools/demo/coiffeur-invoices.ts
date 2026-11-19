/**
 * The one invoice Salon Beispiel writes in 2026: a wedding, hair and make-up for the bride and her
 * bridesmaids on the day. The firm is not registered for VAT, so the invoice carries none and no
 * «MWST» after the UID. The bride pays it by QR reference.
 */
import type { DemoInvoicing } from './kit.js';
import { LEGACY_DUNNING_YAML } from './kit.js';

export const COIFFEUR_INVOICING: DemoInvoicing = {
  address: { street: 'Marktgasse', number: '3', postcode: '8400', town: 'Winterthur', country: 'CH' },
  qrr: true,
  manifest: `invoicing:
  payTo:
    CHF: { account: "1020", qrIban: CH12 3080 8000 0000 0000 4 }
  revenueAccount: "3400"
  paymentTermsDays: 20
  numbering:
    invoice: { format: "{JJJJ}-{NNN}", restartYearly: true }
    credit-note: { format: "{JJJJ}-{NNN}", restartYearly: true }
  texts:
    de: { closing: "Zahlbar innert {days} Tagen. Herzlichen Dank und alles Gute!\\nBella Beispiel" }
${LEGACY_DUNNING_YAML}
`,
  customers: {
    braut: {
      name: 'Lena Muster', address: { street: 'Rosenweg', number: '5', postcode: '8404', town: 'Winterthur', country: 'CH' },
      language: 'de', email: 'lena.muster@mail.example', paymentTermsDays: 20,
    },
  },
  steps: [
    { do: 'issue', key: 'hochzeit', customer: 'braut', at: '2026-06-08T18:00:00.000Z', date: '2026-06-08', subject: 'Hochzeit Lena Muster', supplied: { from: '2026-06-06' },
      lines: [
        { kind: 'text', text: 'Hochzeit vom 6. Juni 2026', style: 'title' },
        { text: 'Probetermin Brautfrisur', quantity: 1, unit: 'flat', price: 90, vatRate: 0 },
        { text: 'Brautfrisur und Make-up am Hochzeitstag', quantity: 1, unit: 'flat', price: 280, vatRate: 0 },
        { text: 'Frisur Brautjungfern', quantity: 3, unit: 'pcs', price: 85, vatRate: 0 },
        { text: 'Anfahrt und Einsatz vor Ort', quantity: 1, unit: 'flat', price: 60, vatRate: 0 },
      ],
      paid: { date: '2026-06-24', bank: 'raiffeisen' } },
  ],
};
