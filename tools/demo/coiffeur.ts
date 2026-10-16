/**
 * The story of Salon Beispiel, a fictional one-chair hair salon in Winterthur run as an
 * Einzelfirma below the VAT registration threshold, for January to September 2026 (the shape every
 * demo shares is in tools/demo/kit.ts). The firm is not registered: every purchase and every sale is
 * booked gross, no entry carries a VAT code, there is no return; the first quarter was closed and
 * sealed without one. What the owner takes out goes on 2850 Privat.
 *
 * Everyone here is invented, and every invented UID has a wrong check digit, so it can never
 * belong to a real company.
 */
import type { VatSetup } from '../../src/workspace/vat-setup.js';
import {
  YEAR, bankDay, invoicesFor, isoDate, lastDay, MONTHS, mulberry32, pad, qrReference,
  type Company, type Demo, type Payment, type Scenario, type StatementBank, type Vendor,
} from './kit.js';

const COMPANY: Company = {
  name: 'Salon Beispiel',
  uid: 'CHE-975.310.864',
  owner: 'Bella Beispiel',
  address: ['Marktgasse 3', '8400 Winterthur'],
};

const VAT: VatSetup = { registered: false };

const BANKS: Record<'raiffeisen', StatementBank> = {
  raiffeisen: {
    bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank Raiffeisen',
    iban: 'CH0080808000000000004', institution: 'Raiffeisenbank Beispiel', opening: 6500,
  },
};

/** The salon's fittings at their book value, and the owner's capital. */
const OPENING_OTHER: Record<string, number> = { '1510': 9000, '2800': 12000 };

const ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['1020', 'Bank Raiffeisen'],
  ['1510', 'Mobiliar und Einrichtungen'],
  ['2000', 'Verbindlichkeiten aus Lieferungen und Leistungen'],
  ['2800', 'Eigenkapital'],
  ['2850', 'Privat'],
  ['2970', 'Gewinnvortrag'],
  ['3200', 'Ertrag Produkteverkauf'],
  ['3400', 'Ertrag Coiffure'],
  ['4200', 'Handelswarenaufwand Produkte'],
  ['4400', 'Verbrauchsmaterial Salon'],
  ['6000', 'Mietaufwand'],
  ['6300', 'Sachversicherungen'],
  ['6400', 'Energie'],
  ['6510', 'Telefon, Internet'],
  ['6600', 'Werbeaufwand'],
  ['6940', 'Bankspesen'],
];

const VENDORS = {
  kosmetik: { name: 'Beispiel Haarkosmetik AG', address: ['Industriestrasse 22', '8404 Winterthur'], uid: 'CHE-753.951.246', bankName: 'BEISPIEL HAARKOSMETIK AG' },
  vermieter: { name: 'Muster Immobilien Winterthur AG', address: ['Stadthausstrasse 10', '8400 Winterthur'], bankName: 'MUSTER IMMOBILIEN WINTERTHUR AG' },
  energie: { name: 'Stadtwerk Beispiel', address: ['Werkstrasse 1', '8400 Winterthur'], uid: 'CHE-864.197.532', bankName: 'STADTWERK BEISPIEL' },
  telecom: { name: 'Muster Telecom AG', address: ['Funkweg 1', '3000 Bern'], uid: 'CHE-864.209.753', bankName: 'Muster Telecom AG' },
  druck: { name: 'Beispiel Druck GmbH', address: ['Tösstalstrasse 5', '8400 Winterthur'], uid: 'CHE-951.753.864', bankName: 'BEISPIEL DRUCK GMBH' },
  versicherung: { name: 'Muster Versicherungen AG', address: ['Policenweg 7', '8004 Zürich'], bankName: 'Muster Versicherungen AG' },
  sumup: { name: 'SumUp Payments Ltd', address: ['London', 'United Kingdom'], bankName: 'SUMUP PAYMENTS LTD' },
} satisfies Record<string, Vendor>;

const invoice = invoicesFor(COMPANY);
const compact = (date: string) => date.replaceAll('-', '');

function scenario(seed: number): Scenario {
  const rnd = mulberry32(seed);
  const between = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 20) / 20;
  const payments: Payment[] = [];

  for (let m = 1; m <= 9; m++) {
    const mm = pad(m);
    const month = `${MONTHS[m - 1]} ${YEAR}`;
    const quarter = Math.ceil(m / 3);

    // Takings: cash paid in twice a month, the card terminal's payouts, TWINT. Gross, no code: the firm charges no VAT.
    for (const day of [14, lastDay(m)]) {
      payments.push({
        bank: 'raiffeisen', date: bankDay(isoDate(2026, m, day)), text: 'Bareinzahlung',
        parts: [{ counterparty: COMPANY.owner.toUpperCase(), text: `Bareinzahlung Kasse ${month}`, legs: [{ account: '3400', amount: between(1100, 1900), text: `Kasse, Bareinnahmen Coiffure ${month}` }], noReceipt: 'Kassabuch des Salons' }],
      });
    }
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 20)), text: 'SumUp Auszahlung',
      parts: [{ counterparty: VENDORS.sumup.bankName, text: `SumUp Auszahlung PO-${YEAR}${mm}`, legs: [{ account: '3400', amount: between(700, 1300), text: `SumUp, Kartenzahlungen Coiffure ${month}` }, { account: '3200', amount: between(200, 480), text: `SumUp, Kartenzahlungen Produkte ${month}` }], noReceipt: 'SumUp Auszahlungsbericht' }],
    });
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 27)), text: 'TWINT Gutschrift',
      parts: [{ counterparty: 'TWINT AG', text: `TWINT Sammelgutschrift ${month}`, legs: [{ account: '3400', amount: between(400, 800), text: `TWINT, Zahlungen Coiffure ${month}` }], noReceipt: 'TWINT Report' }],
    });

    // Products for resale and for the chair: the receipt shows 8.1 % MWST, which the firm cannot deduct; booked gross.
    const kosDate = bankDay(isoDate(2026, m, 9));
    const resale = between(220, 420);
    const consumables = between(90, 210);
    payments.push({
      bank: 'raiffeisen', date: kosDate, text: 'Zahlung Beispiel Haarkosmetik AG',
      parts: [{
        counterparty: VENDORS.kosmetik.bankName, reference: qrReference(`4200${YEAR}${mm}`), text: `Rechnung HK-${YEAR}-${mm}`,
        legs: [{ account: '4200', amount: -resale, text: `Beispiel Haarkosmetik, Verkaufsprodukte ${month}` }, { account: '4400', amount: -consumables, text: `Beispiel Haarkosmetik, Farben und Verbrauchsmaterial ${month}` }],
        doc: invoice({ file: `${compact(kosDate)}-beispiel-haarkosmetik-${YEAR}-${mm}`, vendor: VENDORS.kosmetik, date: isoDate(2026, m, 3), title: 'Rechnung', number: `HK-${YEAR}-${mm}`, description: `Beispiel Haarkosmetik, Produkte ${month}`, currency: 'CHF', items: [{ text: 'Pflegeprodukte für den Verkauf', gross: resale, rate: 8.1 }, { text: 'Farben, Oxidanten, Verbrauchsmaterial', gross: consumables, rate: 8.1 }] }),
      }],
    });

    // Rent by standing order; phone; the owner's monthly draw on Privat.
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 1)), text: 'Dauerauftrag Miete Salon',
      parts: [{ counterparty: VENDORS.vermieter.bankName, text: `Miete Salon ${month}`, legs: [{ account: '6000', amount: -1450, text: `Muster Immobilien, Miete Salon ${month}` }], noReceipt: 'Miete laut Mietvertrag' }],
    });
    const telDate = bankDay(isoDate(2026, m, 18));
    payments.push({
      bank: 'raiffeisen', date: telDate, text: 'eBill Muster Telecom AG',
      parts: [{ counterparty: VENDORS.telecom.bankName, reference: qrReference(`8642${YEAR}${mm}`), text: `Rechnung MT-${YEAR}${mm}`, legs: [{ account: '6510', amount: -59, text: `Muster Telecom, Telefon und Internet ${month}` }], doc: invoice({ file: `${YEAR}${mm}05-muster-telecom-${YEAR}-${mm}`, vendor: VENDORS.telecom, date: isoDate(2026, m, 5), title: 'Rechnung', number: `MT-${YEAR}${mm}`, description: `Muster Telecom, Telefon ${month}`, currency: 'CHF', items: [{ text: `Business-Abo, ${month}`, gross: 59, rate: 8.1 }] }) }],
    });
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 26)), text: `Privatbezug ${COMPANY.owner}`,
      parts: [{ counterparty: COMPANY.owner.toUpperCase(), text: `Privatbezug ${month}`, legs: [{ account: '2850', amount: -2500, text: `Privatbezug ${month}, ${COMPANY.owner}` }], noReceipt: 'Entnahme der Inhaberin: kein Aufwand, kein Entgelt' }],
    });

    // Electricity and bank fees per quarter.
    if (m % 3 === 0) {
      const enDate = bankDay(isoDate(2026, m, 12));
      const energy = between(160, 260);
      payments.push({
        bank: 'raiffeisen', date: enDate, text: 'Zahlung Stadtwerk Beispiel',
        parts: [{ counterparty: VENDORS.energie.bankName, reference: qrReference(`6400${YEAR}${quarter}`), text: `Rechnung SW-${YEAR}-Q${quarter}`, legs: [{ account: '6400', amount: -energy, text: `Stadtwerk Beispiel, Strom und Wasser Q${quarter} ${YEAR}` }], doc: invoice({ file: `${compact(enDate)}-stadtwerk-beispiel-q${quarter}`, vendor: VENDORS.energie, date: isoDate(2026, m, 2), title: 'Rechnung', number: `SW-${YEAR}-Q${quarter}`, description: `Stadtwerk Beispiel, Energie Q${quarter}`, currency: 'CHF', items: [{ text: `Strom und Wasser Q${quarter} ${YEAR}`, gross: energy, rate: 8.1 }] }) }],
      });
      payments.push({
        bank: 'raiffeisen', date: isoDate(2026, m, lastDay(m)), text: 'Kontoführungsgebühren',
        parts: [{ counterparty: 'Raiffeisenbank Beispiel', text: `Kontoführung ${quarter}. Quartal`, legs: [{ account: '6940', amount: -8, text: `Raiffeisen, Kontoführung Q${quarter}` }], noReceipt: 'Bankspesen laut Kontoauszug' }],
      });
    }
  }

  // Insurance for the year, and flyers for the spring offer.
  payments.push({
    bank: 'raiffeisen', date: '2026-01-21', text: 'Zahlung Muster Versicherungen AG',
    parts: [{ counterparty: VENDORS.versicherung.bankName, reference: qrReference(`6300${YEAR}`), text: `Prämienrechnung ${YEAR}`, legs: [{ account: '6300', amount: -680, text: `Muster Versicherungen, Betriebshaftpflicht ${YEAR}` }], doc: invoice({ file: '20260106-muster-versicherungen-praemie-2026', vendor: VENDORS.versicherung, date: '2026-01-06', title: 'Prämienrechnung', number: `PR-${YEAR}-2210`, description: `Muster Versicherungen, Prämie ${YEAR}`, currency: 'CHF', items: [{ text: `Betriebshaftpflicht ${YEAR}`, gross: 680, rate: 0 }], footer: ['Versicherungsprämien sind von der MWST ausgenommen (Art. 21 Abs. 2 Ziff. 18 MWSTG)'] }) }],
  });
  payments.push({
    bank: 'raiffeisen', date: '2026-04-07', text: 'Zahlung Beispiel Druck GmbH',
    parts: [{ counterparty: VENDORS.druck.bankName, reference: qrReference('66002026047'), text: 'Rechnung BD-2026-0312', legs: [{ account: '6600', amount: -240, text: 'Beispiel Druck, Flyer Frühlingsaktion' }], doc: invoice({ file: '20260331-beispiel-druck-flyer', vendor: VENDORS.druck, date: '2026-03-31', title: 'Rechnung', number: 'BD-2026-0312', description: 'Beispiel Druck, Flyer', currency: 'CHF', items: [{ text: 'Flyer A5, 500 Stück', gross: 240, rate: 8.1 }] }) }],
  });

  return { payments, manual: [], correctionCases: [] };
}

const KNOWLEDGE: Record<string, string> = {
  'suppliers/beispiel-haarkosmetik.yaml': `# The products supplier: its receipts show 8.1 % MWST, which a firm that is not registered cannot deduct.
id: beispiel-haarkosmetik
name: Beispiel Haarkosmetik AG
match:
  tx: ["beispiel haarkosmetik"]
  uid: ["CHE-753.951.246"]
accounts: ["4200", "4400"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-haarkosmetik-produkte
        then: { account: "4200", vat: none }
        source: decision 2026-01-12
    precedents: []
`,
};

export const coiffeur: Demo = {
  dir: 'demo-coiffeur',
  company: COMPANY,
  vat: VAT,
  legalForm: 'Einzelfirma',
  closedThrough: '2026-03-31',
  sealedAt: '2026-04-10',
  banks: BANKS,
  ownerAccount: { account: '2850', label: `Privat ${COMPANY.owner}` },
  openingOther: OPENING_OTHER,
  accounts: ACCOUNTS,
  vendors: VENDORS,
  knowledge: KNOWLEDGE,
  scenario,
};
