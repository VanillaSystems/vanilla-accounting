/**
 * What Muster Kaffee GmbH invoiced from July to October 2026: wholesale coffee to cafés and a
 * hotel, barista training, an export to Germany. Every customer is invented; every Swiss UID has
 * a wrong check digit. The paid invoices are paid by QR-bill, so their payments come back in
 * the Raiffeisen camt.053 with the invoice's QR reference (kaffee.ts adds them to the year).
 */
import type { DemoInvoicing } from './kit.js';

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 290 60" width="290" height="60">
  <g fill="#5a3a22"><ellipse cx="30" cy="30" rx="17" ry="25" transform="rotate(28 30 30)"/></g>
  <path d="M22 9c10 10 6 30 16 42" stroke="#f4ece4" stroke-width="3" fill="none" stroke-linecap="round"/>
  <text x="58" y="30" font-family="Helvetica, Arial, sans-serif" font-size="23" font-weight="700" fill="#5a3a22" letter-spacing="1">MUSTER KAFFEE</text>
  <text x="59" y="49" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#8a6a52" letter-spacing="3.2">RÖSTEREI · ZÜRICH</text>
</svg>
`;

export const KAFFEE_INVOICING: DemoInvoicing = {
  address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' },
  manifest: `invoicing:
  payTo:
    CHF: { account: "1021", qrIban: CH44 3199 9123 0008 8901 2 }
    EUR: { account: "1023" }
  revenueAccount: "3300"
  paymentTermsDays: 30
  layout: { logo: invoices/logo.svg, accent: "#5a3a22" }
  texts:
    de: { closing: "Zahlbar innert {days} Tagen.\\nFreundliche Grüsse, Anna Muster" }
    fr: { closing: "Payable dans les {days} jours.\\nMeilleures salutations, Anna Muster" }
`,
  logo: { file: 'invoices/logo.svg', svg: LOGO },
  customers: {
    bistro: {
      name: 'Beispiel Bistro AG', address: { street: 'Seeweg', number: '12', postcode: '3000', town: 'Bern', country: 'CH' },
      language: 'de', vatId: 'CHE-987.654.320 MWST', email: 'buchhaltung@bistro.example', paymentTermsDays: 30,
    },
    hotel: {
      name: 'Muster Hotel GmbH', attn: 'Küche, z. H. Herr Beispiel', address: { street: 'Pilatusstrasse', number: '9', postcode: '6003', town: 'Luzern', country: 'CH' },
      language: 'de', email: 'kueche@musterhotel.example', paymentTermsDays: 20,
    },
    cafe: {
      name: 'Café Exemple Sàrl', address: { street: 'Rue du Marché', number: '12', postcode: '1204', town: 'Genève', country: 'CH' },
      language: 'fr', vatId: 'CHE-111.222.334 TVA', email: 'compta@cafe-exemple.example', paymentTermsDays: 30,
    },
    munich: {
      name: 'Kaffeehaus Beispiel GmbH', address: { street: 'Lindenstrasse', number: '7', postcode: '80331', town: 'München', country: 'DE' },
      language: 'de', vatId: 'DE999999999', email: 'einkauf@kaffeehaus-beispiel.example', paymentTermsDays: 30,
    },
  },
  steps: [
    { do: 'issue', key: 'a', customer: 'bistro', at: '2026-07-06T09:12:00.000Z', date: '2026-07-06', subject: 'Hausmischung und Barista-Schulung',
      lines: [
        { text: 'Hausmischung Espresso, Bohnen 1 kg', quantity: 20, unit: 'pcs', price: 28, vatRate: 2.6 },
        { text: 'Barista-Schulung im Betrieb', quantity: 3, unit: 'h', price: 120, vatRate: 8.1, account: '3600' },
      ],
      paid: { date: '2026-08-04', bank: 'raiffeisen' } },
    { do: 'issue', key: 'b', customer: 'hotel', at: '2026-07-20T14:30:00.000Z', date: '2026-07-20', subject: 'Filterkaffee und Wartung',
      lines: [
        { text: 'Filterkaffee Guji, Bohnen 500 g', quantity: 24, unit: 'pcs', price: 16.5, vatRate: 2.6 },
        { text: 'Wartung Siebträgermaschine, inkl. Dichtungen', quantity: 1, unit: 'flat', price: 180, vatRate: 8.1, account: '3600' },
      ],
      paid: { date: '2026-08-17', bank: 'raiffeisen' } },
    { do: 'issue', key: 'c', customer: 'bistro', at: '2026-08-17T08:05:00.000Z', date: '2026-08-17', subject: 'Hausmischung August',
      lines: [{ text: 'Hausmischung Espresso, Bohnen 1 kg', quantity: 30, unit: 'pcs', price: 28, vatRate: 2.6 }] },
    { do: 'credit', key: 'e', of: 'b', at: '2026-09-02T10:40:00.000Z', amount: 33.86, vatRate: 2.6, reason: '2 Pakete Filterkaffee beschädigt geliefert', settlement: 'offset' },
    { do: 'issue', key: 'd', customer: 'munich', at: '2026-09-21T13:00:00.000Z', date: '2026-09-21', subject: 'Espresso-Mischung, Export', currency: 'EUR', exemption: 'export',
      lines: [
        { text: 'Espresso-Mischung, Bohnen 1 kg', quantity: 40, unit: 'pcs', price: 19.5, vatRate: 0 },
        { text: 'Transport bis Grenze', quantity: 1, unit: 'flat', price: 85, vatRate: 0 },
      ] },
    { do: 'remind', of: 'c', at: '2026-09-28T09:00:00.000Z' },
    { do: 'issue', key: 'f', customer: 'cafe', at: '2026-09-29T15:20:00.000Z', date: '2026-09-29', subject: 'Mélange maison et formation',
      lines: [
        { text: 'Mélange espresso maison, grains 1 kg', quantity: 15, unit: 'pcs', price: 29, vatRate: 2.6 },
        { text: 'Formation barista sur place', quantity: 4, unit: 'h', price: 120, vatRate: 8.1, account: '3600' },
      ] },
    { do: 'issue', key: 'g', customer: 'hotel', at: '2026-10-01T07:45:00.000Z', date: '2026-10-01', subject: 'Filterkaffee Oktober',
      lines: [{ text: 'Filterkaffee Guji, Bohnen 500 g', quantity: 24, unit: 'pcs', price: 16.5, vatRate: 2.6 }] },
    { do: 'cancel', of: 'g', at: '2026-10-02T08:10:00.000Z', reason: 'doppelt erfasst' },
    { do: 'comment', of: 'c', at: '2026-10-06T10:12:00.000Z', text: 'Telefonisch nachgefragt: Buchhaltung war in den Ferien, zahlt bis Ende Oktober.' },
    { do: 'draft', key: 'h', customer: 'hotel', at: '2026-10-09T16:00:00.000Z', date: '2026-10-09', subject: 'Barista-Schulung Oktober',
      lines: [
        { text: 'Barista-Schulung Latte Art, Gruppe bis 6 Personen', quantity: 1, unit: 'day', price: 680, vatRate: 8.1, account: '3600' },
        { text: 'Kursmaterial und Milch', quantity: 1, unit: 'flat', price: 45, vatRate: 8.1, account: '3600' },
      ] },
    { do: 'draft', key: 'i', customer: 'cafe', at: '2026-10-10T11:30:00.000Z', date: '2026-10-10', subject: 'Mélange maison octobre',
      lines: [{ text: 'Mélange espresso maison, grains 1 kg', quantity: 20, unit: 'pcs', price: 29, vatRate: 2.6 }] },
  ],
};
