/**
 * The story of Muster Kaffee GmbH, a fictional coffee roaster with a café and a webshop,
 * for January to September 2026 (the shape every demo shares is in tools/demo/kit.ts).
 *
 * Public vendors (Swiss Post, Coop Pronto, Shopify, Infomaniak, Digitec Galaxus) appear
 * under their real names and public UIDs. Everyone else is invented, and every invented
 * UID has a wrong check digit, so it can never belong to a real company.
 */
import type { CorrectionCase } from '../../src/types/index.js';
import {
  YEAR, bankDay, chf, invoicesFor, isoDate, lastDay, MONTHS, mulberry32, pad, qrReference, r2, taxIn,
  type Company, type Demo, type Doc, type ManualEntry, type Part, type Payment, type Scenario, type StatementBank, type Vendor,
} from './kit.js';
import { KAFFEE_INVOICING } from './kaffee-invoices.js';
import { invoicePayments } from './invoices.js';

const COMPANY: Company = {
  name: 'Muster Kaffee GmbH',
  uid: 'CHE-123.456.789',
  owner: 'Anna Muster',
  address: ['Musterstrasse 1', '8000 Zürich'],
};

const BANKS: Record<'raiffeisen' | 'wise-eur', StatementBank> = {
  raiffeisen: {
    bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank Raiffeisen',
    iban: 'CH6580808000000000001', institution: 'Raiffeisenbank Musterdorf', opening: 18500,
  },
  'wise-eur': {
    bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR',
    iban: 'BE29967000000164', institution: 'Wise Europe SA', opening: 4000,
  },
};

const OPENING_OTHER: Record<string, number> = { '1510': 12000, '1520': 2500, '2800': 20000 };

const ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['1021', 'Bank Raiffeisen'],
  ['1023', 'Wise EUR'],
  ['1170', 'Vorsteuer Material und Dienstleistungen'],
  ['1171', 'Vorsteuer Investitionen und Betriebsaufwand'],
  ['1200', 'Handelswaren'],
  ['1510', 'Mobiliar und Einrichtungen'],
  ['1520', 'Büromaschinen, Informatik'],
  ['2000', 'Verbindlichkeiten aus Lieferungen und Leistungen'],
  ['2200', 'Geschuldete MWST'],
  ['2201', 'Abrechnungskonto MWST'],
  ['2451', 'Kontokorrent Gesellschafterin'],
  ['2800', 'Stammkapital'],
  ['2970', 'Gewinnvortrag'],
  ['3000', 'Ertrag Café'],
  ['3200', 'Ertrag Kaffeebohnen Laden'],
  ['3300', 'Ertrag Grosshandel'],
  ['3400', 'Ertrag Webshop'],
  ['3600', 'Ertrag Schulungen und Service'],
  ['4000', 'Rohkaffee'],
  ['4020', 'Zölle'],
  ['4030', 'Einfuhrsteuer (MWST bei der Einfuhr)'],
  ['4040', 'Vorlageprovision, Verzollungsspesen'],
  ['4210', 'Verbrauchsmaterial Gastronomie'],
  ['6000', 'Mietaufwand'],
  ['6100', 'Unterhalt und Ersatz Einrichtungen'],
  ['6200', 'Fahrzeugaufwand'],
  ['6513', 'Porti und Versand'],
  ['6570', 'Informatik, Hosting, Software'],
  ['6840', 'Zahlungsverkehrsgebühren'],
  ['6940', 'Bankspesen'],
];

const VENDORS = {
  gruenkaffee: { name: 'Grünkaffee Muster AG', address: ['Hafenstrasse 12', '4057 Basel'], uid: 'CHE-999.888.777', bankName: 'Gruenkaffee Muster AG' },
  liegenschaften: { name: 'Liegenschaften Muster AG', address: ['Beispielweg 5', '8000 Zürich'], bankName: 'Liegenschaften Muster AG' },
  terminal: { name: 'Muster Payments AG', address: ['Kartenweg 3', '8005 Zürich'], bankName: 'Muster Payments AG' },
  esempio: { name: 'Torrefazione Esempio S.r.l.', address: ['Via Esempio 7', '34121 Trieste', 'Italien'], uid: 'CHE-111.222.333', bankName: 'TORREFAZIONE ESEMPIO TRIESTE' },
  exampleCloud: { name: 'Example Cloud Inc.', address: ['100 Example Street', 'San Francisco, CA 94105', 'USA'], bankName: 'EXAMPLE CLOUD INC SAN FRANCISCO' },
  post: { name: 'Post CH AG', address: ['Wankdorfallee 4', '3030 Bern'], uid: 'CHE-116.302.542', bankName: 'Post CH AG', public: true },
  coop: { name: 'Coop Pronto', address: ['Tankstelle Musterdorf', '8000 Zürich'], uid: 'CHE-312.150.257', bankName: 'Coop Pronto Musterdorf', public: true },
  shopify: { name: 'Shopify International Ltd.', address: ['2nd Floor, 1-2 Victoria Buildings', 'Haddington Road, Dublin 4', 'Irland'], uid: 'CHE-153.004.184', bankName: 'Shopify Payments', public: true },
  infomaniak: { name: 'Infomaniak Network SA', address: ['Rue Eugène-Marziano 25', '1227 Les Acacias'], uid: 'CHE-103.167.648', bankName: 'Infomaniak Network SA', public: true },
  digitec: { name: 'Digitec Galaxus AG', address: ['Pfingstweidstrasse 60b', '8005 Zürich'], uid: 'CHE-109.049.266', bankName: 'Digitec Galaxus AG', public: true },
  estv: { name: 'Eidg. Steuerverwaltung ESTV', address: ['Schwarztorstrasse 50', '3003 Bern'], bankName: 'Eidg. Steuerverwaltung ESTV' },
} satisfies Record<string, Vendor>;

const invoice = invoicesFor(COMPANY);

// ─── the year ───────────────────────────────────────────────────────────────

function scenario(seed: number): Scenario {
  const rnd = mulberry32(seed);
  /** A CHF amount between lo and hi, on 5 Rappen. */
  const between = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 20) / 20;

  const payments: Payment[] = [];
  const fuel: { date: string; gross: number }[] = [];

  for (let m = 1; m <= 9; m++) {
    const mm = pad(m);
    const month = `${MONTHS[m - 1]} ${YEAR}`;
    const monthEnd = isoDate(2026, m, lastDay(m));

    // Café takings: the card terminal settles once a month, the till report splits the rates.
    const cafe = between(8200, 11800);
    const beans = between(1400, 2600);
    const terminalFee = r2((cafe + beans) * 0.012);
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 28)), text: 'Gutschrift Muster Payments AG',
      parts: [{
        counterparty: VENDORS.terminal.bankName, text: `Abrechnung Kartenzahlungen ${month}`,
        legs: [
          { account: '3000', amount: cafe, vatCode: 'V81', text: `Café, Umsatz ${month}` },
          { account: '3200', amount: beans, vatCode: 'V26', text: `Kaffeebohnen Laden, Umsatz ${month}` },
          { account: '6840', amount: -terminalFee, vatCode: 'I0', text: `Muster Payments, Kommission ${month}` },
        ],
        doc: invoice({
            file: `${YEAR}${mm}28-muster-kaffee-kassenbericht-${YEAR}-${mm}`, vendor: { name: COMPANY.name, address: COMPANY.address, uid: COMPANY.uid, bankName: '' },
            date: isoDate(2026, m, 28), title: 'Kassenbericht', number: `${YEAR}-${mm}`, description: `Kassenbericht ${month}`, currency: 'CHF',
            items: [
              { text: 'Café (Konsumation vor Ort) 8.1%', gross: cafe, rate: 8.1 },
              { text: 'Kaffeebohnen über die Gasse 2.6%', gross: beans, rate: 2.6 },
            ],
            footer: [`Kartenzahlungen, abgerechnet durch Muster Payments AG, Kommission CHF ${chf(terminalFee)}`],
            kind: 'sales-record',
          }),
      }],
    });

    // Webshop: Shopify pays out the month's bean orders less its fees.
    const shop = between(700, 1700);
    const shopFee = r2(shop * 0.029 + 0.3 * Math.round(shop / 45));
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 5)), text: 'Gutschrift Shopify Payments',
      parts: [{
        counterparty: VENDORS.shopify.bankName, reference: `Payout ${YEAR}${mm}`, text: `Shopify Payments Auszahlung ${YEAR}${mm}`,
        legs: [
          { account: '3400', amount: shop, vatCode: 'V26', text: `Webshop, Kaffeebohnen ${month}` },
          { account: '6840', amount: -shopFee, vatCode: 'I0', text: `Shopify Payments, Gebühren ${month}` },
        ],
        doc: invoice({
            file: `${YEAR}${mm}05-shopify-auszahlung-${YEAR}${mm}`, vendor: VENDORS.shopify, date: isoDate(2026, m, 5),
            title: 'Auszahlung', number: `${YEAR}${mm}`, description: `Shopify Auszahlung ${month}`, currency: 'CHF',
            items: [{ text: `Bestellungen Webshop ${month} (Kaffeebohnen)`, gross: shop, rate: 0 }],
            footer: [`Gebühren Shopify Payments: CHF ${chf(shopFee)} (von der Steuer ausgenommen)`, `Auszahlung: CHF ${chf(r2(shop - shopFee))}`],
            kind: 'sales-record',
          }),
      }],
    });

    // Green coffee: one invoice a month, reduced rate, paid by QR bill (in September inside a Sammelzahlung).
    const green = between(1800, 2900);
    const greenDoc = invoice({
      file: `${YEAR}${mm}10-gruenkaffee-muster-rechnung-${YEAR}-${mm}`, vendor: VENDORS.gruenkaffee, date: isoDate(2026, m, 10),
      title: 'Rechnung', number: `GK-${YEAR}-${mm}`, description: `Grünkaffee Muster, Rohkaffee ${month}`, currency: 'CHF',
      items: [
        { text: 'Rohkaffee Brasil Santos, 60 kg', gross: r2(green * 0.55), rate: 2.6 },
        { text: 'Rohkaffee Äthiopien Sidamo, 30 kg', gross: r2(green - r2(green * 0.55)), rate: 2.6 },
      ],
      footer: ['Zahlbar innert 20 Tagen mit QR-Rechnung'],
    });
    const greenPart: Part = {
      counterparty: VENDORS.gruenkaffee.bankName, reference: qrReference(`2026${mm}10`), text: `Rechnung GK-${YEAR}-${mm}`,
      legs: [{ account: '4000', amount: -greenDoc.total, vatCode: 'M26', text: `Grünkaffee Muster, Rohkaffee ${month}` }],
      doc: greenDoc,
    };
    const rentPart: Part = {
      counterparty: VENDORS.liegenschaften.bankName, reference: `Miete Ladenlokal Musterstrasse 1, ${month}`, text: `Miete ${month}`,
      legs: [{ account: '6000', amount: -2400, vatCode: 'I0', text: `Liegenschaften Muster, Miete Ladenlokal ${month}` }],
      noReceipt: 'Dauerauftrag gemäss Mietvertrag vom 1.11.2024; Miete ohne MWST (MWSTG Art. 21 Abs. 2 Ziff. 21)',
    };
    if (m === 9) {
      payments.push({ bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 30)), text: 'Sammelzahlung', parts: [greenPart, rentPart] });
    } else {
      payments.push({ bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 2)), text: 'Dauerauftrag Liegenschaften Muster AG', parts: [rentPart] });
      payments.push({ bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 25)), text: 'Zahlung Gruenkaffee Muster AG', parts: [greenPart] });
    }

    // Swiss Post: the month's parcels on one invoice.
    const post = between(110, 260);
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 20)), text: 'Zahlung Post CH AG',
      parts: [{
        counterparty: VENDORS.post.bankName, reference: qrReference(`5126${mm}20`), text: `Rechnung Post CH ${month}`,
        legs: [{ account: '6513', amount: -post, vatCode: 'I81', text: `Post CH, Pakete Webshop ${month}` }],
        doc: invoice({
          file: `${YEAR}${mm}12-post-ch-rechnung-${YEAR}-${mm}`, vendor: VENDORS.post, date: isoDate(2026, m, 12),
          title: 'Rechnung', number: `9${YEAR}${mm}12`, description: `Post CH, Pakete ${month}`, currency: 'CHF',
          items: [{ text: `PostPac Priority, Sendungen ${month}`, gross: post, rate: 8.1 }],
        }),
      }],
    });

    // Fuel for the delivery van, paid with the debit card.
    const fuelGross = between(68, 96);
    const fuelDate = bankDay(isoDate(2026, m, 14));
    fuel.push({ date: fuelDate, gross: fuelGross });
    payments.push({
      bank: 'raiffeisen', date: fuelDate, text: 'Debitkarte Coop Pronto Musterdorf',
      parts: [{
        counterparty: VENDORS.coop.bankName, text: 'Coop Pronto Musterdorf',
        legs: [{ account: '6200', amount: -fuelGross, vatCode: 'I81', text: 'Coop Pronto Musterdorf, Tanken' }],
        doc: invoice({
          file: `${fuelDate.replaceAll('-', '')}-coop-pronto-tanken`, vendor: VENDORS.coop, date: fuelDate,
          title: 'Quittung', number: `${fuelDate.replaceAll('-', '')}-0417`, description: 'Coop Pronto, Tanken', currency: 'CHF',
          items: [{ text: 'Bleifrei 95', gross: fuelGross, rate: 8.1 }],
        }),
      }],
    });

    // A US software service without Swiss MWST: Bezugsteuer (MWSTG Art. 45), paid from Wise EUR.
    const cloudDate = bankDay(isoDate(2026, m, 3));
    payments.push({
      bank: 'wise-eur', date: cloudDate, text: 'Card transaction of 39.00 EUR issued by Example Cloud Inc SAN FRANCISCO',
      parts: [{
        counterparty: VENDORS.exampleCloud.bankName, text: 'Card transaction of 39.00 EUR issued by Example Cloud Inc SAN FRANCISCO',
        legs: [{ account: '6570', amount: -39, vatCode: 'B81-1', text: `Example Cloud, Kassensystem-Abo ${month} (Bezugsteuer)` }],
        doc: invoice({
          file: `${cloudDate.replaceAll('-', '')}-example-cloud-invoice-${YEAR}-${mm}`, vendor: VENDORS.exampleCloud, date: cloudDate,
          title: 'Invoice', number: `EC-${YEAR}${mm}-0042`, description: `Example Cloud, POS subscription ${month}`, currency: 'EUR',
          items: [{ text: `POS Cloud Pro subscription, ${month}`, gross: 39, rate: 0 }],
          footer: ['Reverse charge: VAT to be accounted for by the recipient'],
        }),
      }],
    });

    // Bank fees at quarter end.
    if (m % 3 === 0) {
      payments.push({
        bank: 'raiffeisen', date: monthEnd, text: 'Kontoführungsgebühren',
        parts: [{ counterparty: 'Raiffeisenbank Musterdorf', text: `Kontoführung ${m / 3}. Quartal`, legs: [{ account: '6940', amount: -15, text: `Raiffeisen, Kontoführung Q${m / 3}` }], noReceipt: 'Bankspesen laut Kontoauszug' }],
      });
    }
  }

  // Barista supplies from an Italian supplier that is registered for Swiss MWST, billed in EUR.
  for (const [date, amount, number] of [['2026-02-17', 1240, 'FT 2026/0188'], ['2026-07-14', 865.5, 'FT 2026/0911']] as const) {
    payments.push({
      bank: 'wise-eur', date, text: `Sent money to ${VENDORS.esempio.name}`,
      parts: [{
        counterparty: VENDORS.esempio.bankName, reference: number, text: `Fattura ${number}`,
        legs: [{ account: '4210', amount: -amount, vatCode: 'M81', text: `Torrefazione Esempio, Barista-Zubehör (${number})` }],
        doc: invoice({
          file: `${date.replaceAll('-', '')}-torrefazione-esempio-fattura`, vendor: VENDORS.esempio, date,
          title: 'Fattura', number, description: 'Torrefazione Esempio, Barista-Zubehör', currency: 'EUR',
          items: [
            { text: 'Tazzine espresso, 120 Stk.', gross: r2(amount * 0.4), rate: 8.1 },
            { text: 'Filtri e guarnizioni', gross: r2(amount - r2(amount * 0.4)), rate: 8.1 },
          ],
          footer: ['Schweizer MWST gemäss Registrierung CHE-111.222.333'],
        }),
      }],
    });
  }

  // Hosting for the webshop domain, once a year.
  payments.push({
    bank: 'raiffeisen', date: '2026-01-12', text: 'Debitkarte Infomaniak Network SA',
    parts: [{
      counterparty: VENDORS.infomaniak.bankName, text: 'Infomaniak.com INTERNET',
      legs: [{ account: '6570', amount: -179.4, vatCode: 'I81', text: 'Infomaniak, Webhosting 2026' }],
      doc: invoice({
        file: '20260112-infomaniak-webhosting-2026', vendor: VENDORS.infomaniak, date: '2026-01-12',
        title: 'Rechnung', number: 'INF-2026-10077', description: 'Infomaniak, Webhosting 2026', currency: 'CHF',
        items: [{ text: 'Web Hosting 12 Monate, muster-kaffee.example', gross: 179.4, rate: 8.1 }],
      }),
    }],
  });

  // A milk-jug set from Digitec Galaxus. Its receipt was missing when Q1 was filed, so the
  // entry went in without input tax (I0); the receipt turned up in April (see the correction below).
  const digitecDoc = invoice({
    file: '20260209-digitec-galaxus-milchkaennchen', vendor: VENDORS.digitec, date: '2026-02-09',
    title: 'Rechnung', number: '118203344', description: 'Digitec Galaxus, Milchkännchen-Set und Tamper', currency: 'CHF',
    items: [{ text: 'Milchkännchen-Set 3-teilig', gross: 79.0, rate: 8.1 }, { text: 'Tamper 58 mm', gross: 50.0, rate: 8.1 }],
  });
  payments.push({
    bank: 'raiffeisen', date: '2026-02-09', text: 'Debitkarte Digitec Galaxus AG',
    parts: [{
      counterparty: VENDORS.digitec.bankName, text: 'Digitec Galaxus AG Zuerich',
      legs: [{ account: '6100', amount: -129, vatCode: 'I0', text: 'Digitec Galaxus, Milchkännchen-Set und Tamper (Beleg fehlt)', key: 'digitec' }],
    }],
  });

  // 30% of the van's fuel in Q2 was private.
  const q2Fuel = r2(fuel.filter((f) => f.date >= '2026-04-01' && f.date <= '2026-06-30').reduce((s, f) => s + f.gross, 0));
  const privateShare = r2(q2Fuel * 0.3);

  const correctionTax = taxIn(129, 8.1);
  const manual: ManualEntry[] = [
    {
      date: '2026-04-15', debit: '', credit: '6100', amount: correctionTax, vatCode: 'I81-2', corrects: '2026-Q1', key: 'digitec-correction',
      text: `Korrekturbuchung zu Buchung {id:digitec} (Q1): Vorsteuer Digitec Galaxus Rechnung 118203344, Beleg nachgereicht; deklariert mit der Korrekturabrechnung Q1 2026`,
      doc: digitecDoc,
    },
    {
      date: '2026-06-30', debit: '2451', credit: '6200', amount: privateShare, vatCode: 'K81-B', key: 'private-fuel',
      text: `Eigenverbrauch: Privatanteil Fahrzeug Q2 2026, 30% von CHF ${chf(q2Fuel)} Treibstoff (${COMPANY.owner})`,
    },
  ];

  const correctionCases: CorrectionCase[] = [{
    id: '2026-Q1-digitec-vorsteuer',
    period: '2026-Q1',
    title: 'Vorsteuer Digitec Galaxus nachgeholt',
    wrong: 'Der Beleg der Digitec-Galaxus-Rechnung 118203344 (CHF 129.00, 8.1% MWST) fehlte beim Einreichen, die Buchung lief ohne Vorsteuer (I0).',
    fix: `Korrekturbuchung I81-2 über CHF ${chf(correctionTax)} vom 15.04.2026 mit corrects 2026-Q1; die Buchung vom Februar bleibt wie eingereicht.`,
    originalEntryIds: ['digitec'],
    correctionEntryIds: ['digitec-correction'],
    source: 'receipts/20260209-digitec-galaxus-milchkaennchen.pdf',
  }];

  // Wholesale customers pay their invoices by QR-bill (kaffee-invoices.ts).
  payments.push(...invoicePayments(KAFFEE_INVOICING));

  return {
    payments,
    manual,
    correctionCases,
    taxPayment: (payable) => ({
      bank: 'raiffeisen', date: '2026-05-29', text: 'Zahlung Eidg. Steuerverwaltung ESTV',
      parts: [{
        counterparty: VENDORS.estv.bankName, reference: qrReference('46112345678912026'), text: 'MWST 1. Quartal 2026',
        legs: [{ account: '2201', amount: -payable, text: 'ESTV, MWST-Abrechnung Q1 2026' }],
        noReceipt: 'MWST-Abrechnung Q1 2026, filings/2026/mwst-ech0217-2026-Q1.xml',
      }],
    }),
  };
}

const KNOWLEDGE: Record<string, string> = {
  // A binding of a public vendor: only what is true for this company.
  'suppliers/swiss-post.yaml': `# Binding of the public file processes/suppliers/swiss-post.yaml to Muster Kaffee's chart.
id: swiss-post
accounts: ["6513"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-post-parcels
        when: the monthly Post CH invoice for webshop parcels
        then: '6513 Porti und Versand, I81; description "Post CH, Pakete Webshop <Monat>"'
        source: decision 2026-01-20
    precedents: []
`,
  // A private supplier with no public twin carries its own name and match signals.
  'suppliers/gruenkaffee-muster.yaml': `# A private supplier: no public file, so this one is the whole business.
id: gruenkaffee-muster
name: Grünkaffee Muster AG
match:
  tx: ["gruenkaffee muster"]
  uid: ["CHE-999.888.777"]
  file: ['^\\d{8}-gruenkaffee-muster']
accounts: ["4000"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-gruenkaffee-green-coffee
        when: a Grünkaffee Muster invoice for green coffee
        then: '4000 Rohkaffee, M26 (green coffee is food, reduced rate 2.6%); one entry per invoice'
        source: decision 2026-01-25
    precedents: []
`,
  // The prose notes beside the partner files, and the company's own pages (docs/0.4.0/knowledge.md "Files").
  'suppliers/gruenkaffee-muster.md': `Grünkaffee Muster AG liefert unseren Rohkaffee, je nach Ernte aus Brasilien, Kolumbien und Äthiopien. Sie ist unser grösster Lieferant.

Die Rechnung kommt als PDF per Mail, eine pro Lieferung, und wir zahlen sie innert 30 Tagen per Überweisung. Auf der Rechnung steht die UID CHE-999.888.777.

So buchen wir sie:

- Rohkaffee auf **4000 Rohkaffee**, mit 2.6 % MWST (Kaffee ist ein Lebensmittel).
- Jede Rechnung ist eine eigene Buchung, auch wenn zwei am selben Tag bezahlt werden.
- Jutesäcke und Verpackung, die sie manchmal mitliefert, gehören auf 4210 Verbrauchsmaterial Gastronomie, mit 8.1 %.
`,
  'suppliers/swiss-post.md': `Die Post bringt unsere Webshop-Pakete. Sie stellt einmal im Monat eine Sammelrechnung für alle Pakete des Vormonats.

Die Rechnung lädt Anna im Geschäftskundenportal der Post herunter; per Mail kommt nur der Hinweis, dass sie bereit ist.

Wir buchen sie auf **6513 Porti und Versand** mit 8.1 % MWST, als «Post CH, Pakete Webshop» mit dem Monat.
`,
  'suppliers/coop-pronto.md': `An der Coop-Pronto-Tankstelle in Musterdorf tanken wir den Lieferwagen, mit der Debitkarte der Firma.

Den Kassenzettel fotografiert Anna mit dem Handy. Ist er unleserlich, gilt trotzdem 8.1 % MWST: Coop Pronto rechnet immer so ab.

Treibstoff gehört auf 6200 Fahrzeugaufwand. Den privaten Anteil buchen wir einmal im Quartal, siehe «Fahrzeug und Privatanteil».
`,
  'company/fahrzeug.md': `---
title: Fahrzeug und Privatanteil
steps: [booking#eigenverbrauch, booking#private]
---

Der Lieferwagen ist ein Firmenwagen: Treibstoff, Service und Parkgebühren gehören der Firma, auf 6200 Fahrzeugaufwand.

Anna fährt ihn auch privat. Darum buchen wir am Ende jedes Quartals 30 % des Treibstoffs als Privatanteil auf 2451 Kontokorrent Gesellschafterin, mit der Vorsteuerkorrektur K81-B.
`,
  'company/belege-sammeln.md': `---
title: Belege sammeln
steps: [receipt-collection#triage]
---

Rechnungen kommen per Mail an belege@muster-kaffee.example. Kassenzettel fotografiert Anna mit dem Handy und lädt sie in der App hoch.

Was nur im Kundenkonto eines Lieferanten liegt (die Post), holt Anna einmal im Monat selbst.

Ein Beleg ohne MWST-Ausweis ist trotzdem ein Beleg, nur ohne Vorsteuer.
`,
  'company/mwst-abrechnung.md': `---
title: MWST-Abrechnung
---

Wir rechnen effektiv ab, pro Quartal, nach vereinnahmten Entgelten: es zählt das Zahlungsdatum, nicht das Rechnungsdatum.

Ein eingereichtes Quartal ändern wir nie. Eine Korrektur kommt ins offene Quartal und in die Korrekturabrechnung des Quartals, das sie betrifft.
`,
};

export const kaffee: Demo = {
  dir: 'demo',
  company: COMPANY,
  closedThrough: '2026-03-31',
  filed: { period: '2026-Q1', generationTime: '2026-04-28T08:15:00' },
  banks: BANKS,
  ownerAccount: { account: '2451', label: `Kontokorrent ${COMPANY.owner}` },
  openingOther: OPENING_OTHER,
  accounts: ACCOUNTS,
  vendors: VENDORS,
  knowledge: KNOWLEDGE,
  scenario,
  invoicing: KAFFEE_INVOICING,
};
