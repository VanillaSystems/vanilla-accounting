/**
 * What Muster Consulting GmbH invoices in the app from July 2026 (until June the owner wrote his
 * invoices elsewhere; consulting.ts books those as sales records): the monthly mandate of its main
 * Swiss client by the hour, and the security audit of a client in Munich in EUR, a service whose
 * place of supply is abroad (Art. 8 Abs. 1 MWSTG, Ziffer 221: no Swiss VAT, the note printed). The
 * Swiss client pays by QR reference, the German one by creditor reference to the Wise EUR account;
 * the September audit is open. The amounts are those the old invoices had, so the figures stay.
 */
import { LEGACY_DUNNING_YAML, bankDay, isoDate, type DemoInvoicing, type InvoiceStep } from './kit.js';

const TREUHAND_HOURS = 40;
const RATE_CHF = 150;
const RATE_EUR = 200;

/** The mandate of July to September, each billed on the month's first banking day after the 1st and paid on the 20th. */
const mandate: InvoiceStep[] = [7, 8, 9].map((m) => {
  const date = bankDay(isoDate(2026, m, 2));
  const month = ['Juli', 'August', 'September'][m - 7];
  return {
    do: 'issue', key: `treuhand-${m}`, customer: 'treuhand', at: `${date}T08:30:00.000Z`, date, subject: `Beratungsmandat IT-Sicherheit, ${month} 2026`,
    supplied: { from: isoDate(2026, m, 1), to: isoDate(2026, m, new Date(Date.UTC(2026, m, 0)).getUTCDate()) },
    lines: [{ text: `Beratungsmandat IT-Sicherheit, ${month} 2026`, quantity: TREUHAND_HOURS, unit: 'h', price: RATE_CHF, vatRate: 8.1 }],
    paid: { date: bankDay(isoDate(2026, m, 20)), bank: 'raiffeisen' },
  };
});

export const CONSULTING_INVOICING: DemoInvoicing = {
  address: { street: 'Beispielgasse', number: '8', postcode: '3011', town: 'Bern', country: 'CH' },
  qrr: true,
  manifest: `invoicing:
  payTo:
    CHF: { account: "1020", qrIban: CH66 3080 8000 0000 0000 2 }
    EUR: { account: "1021" }
  revenueAccount: "3400"
  paymentTermsDays: 30
  numbering:
    invoice: { format: "{JJJJ}-{NNN}", restartYearly: true }
    credit-note: { format: "{JJJJ}-{NNN}", restartYearly: true }
  paymentTerms:
    - { id: net30, name: "30 Tage netto", days: 30 }
  texts:
    de: { closing: "Zahlbar innert {days} Tagen.\\nFreundliche Grüsse, Lukas Beispiel" }
    en: { closing: "Payable within {days} days.\\nKind regards, Lukas Beispiel" }
${LEGACY_DUNNING_YAML}
`,
  customers: {
    treuhand: {
      name: 'Beispiel Treuhand AG', address: { street: 'Seestrasse', number: '40', postcode: '8002', town: 'Zürich', country: 'CH' },
      language: 'de', vatId: 'CHE-318.642.975 MWST', email: 'kreditoren@beispiel-treuhand.example', paymentTermsDays: 30,
    },
    maschinenbau: {
      name: 'Muster Maschinenbau GmbH', attn: 'Einkauf', address: { street: 'Beispielstrasse', number: '3', postcode: '80331', town: 'München', country: 'DE' },
      language: 'de', vatId: 'DE999999998', email: 'einkauf@muster-maschinenbau.example', paymentTermsDays: 30,
    },
  },
  steps: [
    mandate[0],
    { do: 'issue', key: 'audit-7', customer: 'maschinenbau', at: '2026-07-07T09:00:00.000Z', date: '2026-07-07', subject: 'Sicherheitsaudit Fernwartung, Juli', currency: 'EUR', exemption: 'abroad',
      supplied: { from: '2026-07-01', to: '2026-07-06' },
      lines: [{ text: 'Sicherheitsaudit Fernwartung, Analyse und Bericht', quantity: 19, unit: 'h', price: RATE_EUR, vatRate: 0 }],
      paid: { date: '2026-07-28', bank: 'wise-eur' } },
    mandate[1],
    mandate[2],
    // The September audit, billed on 1 October: open.
    { do: 'issue', key: 'audit-9', customer: 'maschinenbau', at: '2026-10-01T09:00:00.000Z', date: '2026-10-01', subject: 'Sicherheitsaudit Fernwartung, September', currency: 'EUR', exemption: 'abroad',
      supplied: { from: '2026-09-14', to: '2026-09-25' },
      lines: [{ text: 'Sicherheitsaudit Fernwartung, Nachprüfung', quantity: 12, unit: 'h', price: RATE_EUR, vatRate: 0 }] },
  ],
};
