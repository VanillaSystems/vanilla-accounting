/**
 * What Muster Kaffee GmbH invoiced from July to October 2026: wholesale coffee to cafés, a hotel,
 * a catering firm and a bakery, barista training, an export to Germany. Every customer is
 * invented; every Swiss UID has a wrong check digit. Most invoices are paid by QR-bill, so their
 * payments come back in the Raiffeisen camt.053 with the invoice's QR reference (kaffee.ts adds
 * them to the year); the rest shows each state a person meets after the invoice (spec
 * docs/specs/invoicing.md 4.10, phase 1): paid with Skonto, partly paid, short by the bank's fee
 * and written off as Spesen, paid in cash at the door, entered by hand and confirmed by the
 * statement, one payment ausgeziffert over two invoices, a credit note applied to its invoice, an
 * overdue one with its first reminder, one cancelled, two not sent yet, two drafts.
 */
import type { InvoiceLine, Prices } from '../../src/invoices/model.js';
import { totals } from '../../src/invoices/rules.js';
import type { DemoInvoicing } from './kit.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
/** What a customer pays who takes the Skonto: the total less `percent` of it, to the Rappen. */
const lessSkonto = (lines: InvoiceLine[], prices: Prices, percent: number) => { const g = totals({ lines, prices }).gross; return r2(g - r2(g * percent / 100)); };

/** Coffee at the reduced rate and a grinder at the normal rate, priced with VAT, 2 % Rabatt on the total (P1.3). */
const BAR_AUGUST: InvoiceLine[] = [
  { text: 'Hausmischung Espresso, Bohnen', quantity: 40, unit: 'kg', price: 29.5, vatRate: 2.6 },
  { text: 'Kaffeemühle Muster E65, Vorführgerät', quantity: 1, unit: 'pcs', price: 690, vatRate: 8.1, account: '3600' },
  { kind: 'discount', text: 'Rabatt Neukunde', percent: 2 },
];
/** 20 bags of filter coffee to the canteen; 2 of them come back torn (the credit note). */
const KANTINE_SEPT: InvoiceLine[] = [{ text: 'Filterkaffee Guji, Bohnen 500 g', quantity: 20, unit: 'pcs', price: 16.5, vatRate: 2.6 }];
const KANTINE_CREDIT = r2(2 * 16.5 * 1.026);


const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 290 60" width="290" height="60">
  <g fill="#5a3a22"><ellipse cx="30" cy="30" rx="17" ry="25" transform="rotate(28 30 30)"/></g>
  <path d="M22 9c10 10 6 30 16 42" stroke="#f4ece4" stroke-width="3" fill="none" stroke-linecap="round"/>
  <text x="58" y="30" font-family="Helvetica, Arial, sans-serif" font-size="23" font-weight="700" fill="#5a3a22" letter-spacing="1">MUSTER KAFFEE</text>
  <text x="59" y="49" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#8a6a52" letter-spacing="3.2">RÖSTEREI · ZÜRICH</text>
</svg>
`;

export const KAFFEE_INVOICING: DemoInvoicing = {
  address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' },
  qrr: true,
  cash: { account: '1000', label: 'Kasse' },
  manifest: `invoicing:
  payTo:
    CHF: { account: "1021", qrIban: CH44 3199 9123 0008 8901 2 }
    EUR: { account: "1023" }
  revenueAccount: "3300"
  paymentTermsDays: 30
  paymentTerms:
    - { id: net30, name: "30 Tage netto", days: 30 }
    - { id: net20, name: "20 Tage netto", days: 20 }
    - { id: skonto2, name: "10 Tage 2 %, 30 Tage netto", days: 30, skonto: { percent: 2, days: 10 }, text: "Zahlbar innert 10 Tagen mit 2 % Skonto oder innert 30 Tagen netto." }
  defaultTerms: net30
  layout: { logo: logos/logo.svg, accent: "#5a3a22" }
  texts:
    de: { closing: "Zahlbar innert {days} Tagen.\\nFreundliche Grüsse, Anna Muster" }
    fr: { closing: "Payable dans les {days} jours.\\nMeilleures salutations, Anna Muster" }
`,
  logo: { file: 'logos/logo.svg', svg: LOGO },
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
    catering: {
      name: 'Muster Catering AG', address: { street: 'Industriestrasse', number: '40', postcode: '8400', town: 'Winterthur', country: 'CH' },
      language: 'de', email: 'kreditoren@muster-catering.example', paymentTermsDays: 30,
    },
    bar: {
      name: 'Kaffeebar Beispiel GmbH', address: { street: 'Bahnhofplatz', number: '3', postcode: '9000', town: 'St. Gallen', country: 'CH' },
      language: 'de', email: 'hallo@kaffeebar-beispiel.example', paymentTermsDays: 30,
    },
    kantine: {
      name: 'Beispiel Kantine AG', address: { street: 'Werkstrasse', number: '8', postcode: '5000', town: 'Aarau', country: 'CH' },
      language: 'de', email: 'einkauf@beispiel-kantine.example', paymentTermsDays: 30,
    },
    baeckerei: {
      name: 'Bäckerei Muster', address: { street: 'Dorfstrasse', number: '21', postcode: '8610', town: 'Uster', country: 'CH' },
      language: 'de', paymentTermsDays: 30,
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
    // Two invoices to the caterer, priced with VAT; it pays both in one sum, CHF 20 short (Ausziffern, P1.5).
    { do: 'issue', key: 'o', customer: 'catering', at: '2026-07-27T10:05:00.000Z', date: '2026-07-27', subject: 'Hausmischung Juli', prices: 'gross',
      lines: [{ text: 'Hausmischung Espresso, Bohnen', quantity: 60, unit: 'kg', price: 27, vatRate: 2.6 }] },
    { do: 'issue', key: 's', customer: 'bar', at: '2026-08-03T08:40:00.000Z', date: '2026-08-03', subject: 'Erstausstattung Kaffeebar', prices: 'gross', termsId: 'skonto2',
      lines: BAR_AUGUST, paid: { date: '2026-08-11', bank: 'raiffeisen', amount: lessSkonto(BAR_AUGUST, 'gross', 2) } },
    { do: 'issue', key: 'p', customer: 'catering', at: '2026-08-10T10:15:00.000Z', date: '2026-08-10', subject: 'Espresso August', prices: 'gross',
      lines: [{ text: 'Espresso-Mischung Crema, Bohnen', quantity: 40, unit: 'kg', price: 39.5, vatRate: 2.6 }] },
    { do: 'issue', key: 'c', customer: 'bistro', at: '2026-08-17T08:05:00.000Z', date: '2026-08-17', subject: 'Hausmischung August',
      lines: [{ text: 'Hausmischung Espresso, Bohnen 1 kg', quantity: 30, unit: 'pcs', price: 28, vatRate: 2.6 }] },
    { do: 'issue', key: 'k', customer: 'hotel', at: '2026-08-24T13:20:00.000Z', date: '2026-08-24', subject: 'Filterkaffee August',
      lines: [{ text: 'Filterkaffee Guji, Bohnen 500 g', quantity: 48, unit: 'pcs', price: 16.5, vatRate: 2.6 }],
      paid: { date: '2026-09-21', bank: 'raiffeisen', amount: 400 } },
    { do: 'issue', key: 'l', customer: 'bistro', at: '2026-08-28T09:30:00.000Z', date: '2026-08-28', subject: 'Nachlieferung Hausmischung',
      lines: [{ text: 'Hausmischung Espresso, Bohnen 1 kg', quantity: 10, unit: 'pcs', price: 28, vatRate: 2.6 }],
      paid: { date: '2026-09-14', bank: 'raiffeisen', amount: 283.78 } },
    { do: 'credit', key: 'e', of: 'b', at: '2026-09-02T10:40:00.000Z', amount: 33.86, vatRate: 2.6, reason: '2 Pakete Filterkaffee beschädigt geliefert', settlement: 'offset' },
    { do: 'issue', key: 'n', customer: 'cafe', at: '2026-09-07T15:00:00.000Z', date: '2026-09-07', subject: 'Mélange maison septembre',
      lines: [{ text: 'Mélange espresso maison, grains 1 kg', quantity: 10, unit: 'pcs', price: 29, vatRate: 2.6 }] },
    { do: 'allocate', key: 'op', at: '2026-09-10T09:00:00.000Z', bank: 'raiffeisen', payer: 'Muster Catering AG', text: 'Rechnungen {o} und {p}',
      parts: [{ of: 'o', amount: 1620 }, { of: 'p', amount: 1560, rest: 'fee' }] },
    { do: 'issue', key: 'q', customer: 'kantine', at: '2026-09-14T11:00:00.000Z', date: '2026-09-14', subject: 'Filterkaffee September',
      lines: KANTINE_SEPT, paid: { date: '2026-09-29', bank: 'raiffeisen', amount: r2(totals({ lines: KANTINE_SEPT }).gross - KANTINE_CREDIT) } },
    { do: 'write-off', of: 'l', at: '2026-09-15T08:30:00.000Z', reason: 'fee', note: 'Bankspesen des Kunden' },
    { do: 'hand', key: 'n-hand', of: 'n', at: '2026-09-16T17:10:00.000Z', account: '1021', statement: { date: '2026-09-18', bank: 'raiffeisen' } },
    { do: 'credit', key: 'r', of: 'q', at: '2026-09-17T09:15:00.000Z', amount: KANTINE_CREDIT, vatRate: 2.6, reason: '2 Pakete Filterkaffee aufgerissen geliefert' },
    { do: 'issue', key: 'd', customer: 'munich', at: '2026-09-21T13:00:00.000Z', date: '2026-09-21', subject: 'Espresso-Mischung, Export', currency: 'EUR', exemption: 'export',
      lines: [
        { text: 'Espresso-Mischung, Bohnen 1 kg', quantity: 40, unit: 'pcs', price: 19.5, vatRate: 0 },
        { text: 'Transport bis Grenze', quantity: 1, unit: 'flat', price: 85, vatRate: 0 },
      ] },
    { do: 'remind', of: 'c', at: '2026-09-28T09:00:00.000Z' },
    { do: 'issue', key: 'f', customer: 'cafe', at: '2026-09-29T15:20:00.000Z', date: '2026-09-29', subject: 'Mélange maison et formation', send: 'download',
      lines: [
        { text: 'Mélange espresso maison, grains 1 kg', quantity: 15, unit: 'pcs', price: 29, vatRate: 2.6 },
        { text: 'Formation barista sur place', quantity: 4, unit: 'h', price: 120, vatRate: 8.1, account: '3600' },
      ] },
    { do: 'issue', key: 'g', customer: 'hotel', at: '2026-10-01T07:45:00.000Z', date: '2026-10-01', subject: 'Filterkaffee Oktober',
      lines: [{ text: 'Filterkaffee Guji, Bohnen 500 g', quantity: 24, unit: 'pcs', price: 16.5, vatRate: 2.6 }] },
    { do: 'cancel', of: 'g', at: '2026-10-02T08:10:00.000Z', reason: 'doppelt erfasst' },
    // The bakery picks its beans up and pays cash at the door: the invoice is printed and handed over.
    { do: 'issue', key: 'm', customer: 'baeckerei', at: '2026-10-05T07:30:00.000Z', date: '2026-10-05', subject: 'Hausmischung Oktober', send: 'download',
      lines: [{ text: 'Hausmischung Espresso, Bohnen 1 kg', quantity: 12, unit: 'pcs', price: 28, vatRate: 2.6 }] },
    { do: 'hand', key: 'm-cash', of: 'm', at: '2026-10-05T07:35:00.000Z', account: '1000' },
    { do: 'comment', of: 'c', at: '2026-10-06T10:12:00.000Z', text: 'Telefonisch nachgefragt: Buchhaltung war in den Ferien, zahlt bis Ende Oktober.' },
    { do: 'draft', key: 'h', customer: 'hotel', at: '2026-10-09T16:00:00.000Z', date: '2026-10-09', subject: 'Barista-Schulung Oktober',
      lines: [
        { text: 'Barista-Schulung Latte Art, Gruppe bis 6 Personen', quantity: 1, unit: 'day', price: 680, vatRate: 8.1, account: '3600' },
        { text: 'Kursmaterial und Milch', quantity: 1, unit: 'flat', price: 45, vatRate: 8.1, account: '3600' },
      ] },
    // A draft with position kinds: a title per part, a subtotal under each, a Rabatt on the total.
    { do: 'draft', key: 'i', customer: 'cafe', at: '2026-10-10T11:30:00.000Z', date: '2026-10-10', subject: 'Mélange maison et accessoires octobre',
      lines: [
        { kind: 'text', text: 'Café en grains', style: 'title' },
        { text: 'Mélange espresso maison, grains 1 kg', quantity: 20, unit: 'pcs', price: 29, vatRate: 2.6 },
        { kind: 'subtotal', text: 'Sous-total café' },
        { kind: 'text', text: 'Accessoires', style: 'title' },
        { text: 'Pichet à lait 600 ml, inox', quantity: 2, unit: 'pcs', price: 24, vatRate: 8.1, account: '3600' },
        { kind: 'subtotal', text: 'Sous-total accessoires' },
        { kind: 'discount', text: 'Rabais client fidèle', percent: 5 },
      ] },
    // Issued, not sent yet: «Nicht gesendet» shows them.
    { do: 'issue', key: 't', customer: 'catering', at: '2026-10-12T14:00:00.000Z', date: '2026-10-12', subject: 'Hausmischung Oktober', prices: 'gross', send: 'none',
      lines: [{ text: 'Hausmischung Espresso, Bohnen', quantity: 30, unit: 'kg', price: 27, vatRate: 2.6 }] },
    { do: 'issue', key: 'u', customer: 'bar', at: '2026-10-14T16:45:00.000Z', date: '2026-10-14', subject: 'Nachbestellung Oktober', prices: 'gross', termsId: 'skonto2', send: 'none',
      lines: [{ text: 'Hausmischung Espresso, Bohnen', quantity: 20, unit: 'kg', price: 29.5, vatRate: 2.6 }] },
  ],
};
