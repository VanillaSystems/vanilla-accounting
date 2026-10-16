/**
 * The story of Muster Consulting GmbH, a fictional one-person IT consultancy in Bern, for
 * January to September 2026 (the shape every demo shares is in tools/demo/kit.ts). The owner
 * is its only employee: he pays himself a salary, bills Swiss and foreign clients, and pays
 * some expenses privately and gets them back once a month.
 *
 * Public vendors (Digitec Galaxus, SBB) appear under their real names and public UIDs.
 * Everyone else is invented, and every invented UID has a wrong check digit.
 */
import type { CorrectionCase } from '../../src/types/index.js';
import {
  YEAR, bankDay, chf, invoicesFor, isoDate, lastDay, MONTHS, mulberry32, pad, PAID_PRIVATELY, qrReference, r2, taxIn,
  type Company, type Demo, type ManualEntry, type Payment, type Scenario, type StatementBank, type Vendor,
} from './kit.js';

const COMPANY: Company = {
  name: 'Muster Consulting GmbH',
  uid: 'CHE-246.813.579',
  owner: 'Lukas Beispiel',
  address: ['Beispielgasse 8', '3011 Bern'],
};

const BANKS: Record<'raiffeisen' | 'wise-eur', StatementBank> = {
  raiffeisen: {
    bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank Raiffeisen',
    iban: 'CH3880808000000000002', institution: 'Raiffeisenbank Bern-Muster', opening: 42000,
  },
  'wise-eur': {
    bank: 'Wise', currency: 'EUR', account: '1021', label: 'Wise EUR',
    iban: 'BE38967000000002', institution: 'Wise Europe SA', opening: 2500,
  },
};

/** The laptop of 2024 at its book value, and the share capital. */
const OPENING_OTHER: Record<string, number> = { '1520': 1800, '2800': 20000 };

/** KMU-Kontenrahmen numbers; 2451 is the owner's current account the app's processes name. */
const ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['1020', 'Bank Raiffeisen'],
  ['1021', 'Wise EUR'],
  ['1170', 'Vorsteuer Material und Dienstleistungen'],
  ['1171', 'Vorsteuer Investitionen und Betriebsaufwand'],
  ['1520', 'Büromaschinen, Informatik'],
  ['2000', 'Verbindlichkeiten aus Lieferungen und Leistungen'],
  ['2200', 'Geschuldete MWST'],
  ['2201', 'Abrechnungskonto MWST'],
  ['2270', 'Sozialversicherungen und Vorsorgeeinrichtungen'],
  ['2451', 'Kontokorrent Gesellschafter'],
  ['2800', 'Stammkapital'],
  ['2970', 'Gewinnvortrag'],
  ['3400', 'Ertrag Beratung'],
  ['5000', 'Lohnaufwand'],
  ['5700', 'AHV, IV, EO, ALV'],
  ['5720', 'Berufliche Vorsorge'],
  ['5730', 'Unfallversicherung'],
  ['5740', 'Krankentaggeldversicherung'],
  ['5810', 'Aus- und Weiterbildung'],
  ['6000', 'Raumaufwand'],
  ['6500', 'Büromaterial, Fachliteratur'],
  ['6510', 'Telefon, Internet'],
  ['6570', 'Informatik, Software'],
  ['6640', 'Reisespesen'],
  ['6641', 'Kundenbetreuung'],
  ['6940', 'Bankspesen'],
];

const VENDORS = {
  treuhand: { name: 'Beispiel Treuhand AG', address: ['Seestrasse 40', '8002 Zürich'], uid: 'CHE-318.642.975', bankName: 'BEISPIEL TREUHAND AG' },
  logistik: { name: 'Muster Logistik AG', address: ['Industrieweg 12', '3052 Zollikofen'], bankName: 'MUSTER LOGISTIK AG' },
  maschinenbau: { name: 'Muster Maschinenbau GmbH', address: ['Beispielstrasse 3', '80331 München', 'Deutschland'], bankName: 'MUSTER MASCHINENBAU GMBH' },
  analytics: { name: 'Example Analytics Inc.', address: ['500 Sample Avenue', 'Austin, TX 78701', 'USA'], bankName: 'EXAMPLE ANALYTICS INC' },
  coworking: { name: 'Muster Coworking AG', address: ['Werkhofgasse 2', '3011 Bern'], uid: 'CHE-135.792.468', bankName: 'Muster Coworking AG' },
  telecom: { name: 'Muster Telecom AG', address: ['Funkweg 1', '3000 Bern'], uid: 'CHE-864.209.753', bankName: 'Muster Telecom AG' },
  sampleLabs: { name: 'Sample Labs Inc.', address: ['1 Example Plaza', 'Seattle, WA 98101', 'USA'], bankName: 'SAMPLE LABS INC SEATTLE' },
  beispielSoftware: { name: 'Beispiel Software GmbH', address: ['Musterallee 21', '10115 Berlin', 'Deutschland'], uid: 'CHE-579.246.813', bankName: 'BEISPIEL SOFTWARE BERLIN' },
  digitec: { name: 'Digitec Galaxus AG', address: ['Pfingstweidstrasse 60b', '8005 Zürich'], uid: 'CHE-109.049.266', bankName: 'Digitec Galaxus AG', public: true },
  sbb: { name: 'Schweizerische Bundesbahnen SBB', address: ['Hilfikerstrasse 1', '3000 Bern 65'], uid: 'CHE-102.909.703', bankName: 'SBB CFF FFS', public: true },
  restaurant: { name: 'Restaurant Beispielhof', address: ['Marktgasse 9', '3011 Bern'], uid: 'CHE-192.837.465', bankName: 'Restaurant Beispielhof' },
  buchhandlung: { name: 'Buchhandlung Muster', address: ['Spitalgasse 5', '3011 Bern'], uid: 'CHE-283.746.519', bankName: 'Buchhandlung Muster' },
  akademie: { name: 'Muster Akademie', address: ['Schulweg 4', '3012 Bern'], bankName: 'Muster Akademie' },
  ausgleichskasse: { name: 'Ausgleichskasse Muster', address: ['Postfach', '3001 Bern'], bankName: 'Ausgleichskasse Muster' },
  vorsorge: { name: 'Muster Sammelstiftung BVG', address: ['Vorsorgeplatz 1', '4002 Basel'], bankName: 'Muster Sammelstiftung BVG' },
  versicherung: { name: 'Muster Versicherungen AG', address: ['Policenweg 7', '8004 Zürich'], bankName: 'Muster Versicherungen AG' },
  parkhaus: { name: 'Parkhaus Beispiel', address: ['Bahnhofplatz 1', '3011 Bern'], bankName: 'PARKHAUS BEISPIEL BERN' },
  estv: { name: 'Eidg. Steuerverwaltung ESTV', address: ['Schwarztorstrasse 50', '3003 Bern'], bankName: 'Eidg. Steuerverwaltung ESTV' },
} satisfies Record<string, Vendor>;

/**
 * The owner's monthly salary. Employee deductions: AHV/IV/EO 5.3%, ALV 1.1%, and half of the BVG
 * premium. The Ausgleichskasse bills both halves of AHV/IV/EO/ALV plus the FAK as a quarterly Akonto.
 */
const GROSS_SALARY = 8600;
const BVG_QUARTER = 1425;
const BVG_EMPLOYEE = r2(BVG_QUARTER / 2 / 3);
const AHV_EMPLOYEE = r2(GROSS_SALARY * 0.053 + GROSS_SALARY * 0.011);
const EMPLOYEE_DEDUCTIONS = r2(AHV_EMPLOYEE + BVG_EMPLOYEE);
const NET_SALARY = r2(GROSS_SALARY - EMPLOYEE_DEDUCTIONS);
const AHV_EMPLOYEE_QUARTER = r2(3 * AHV_EMPLOYEE);
const AHV_AKONTO = 3612.6;

const invoice = invoicesFor(COMPANY);
/** The company as the issuer of its own invoices. */
const SELF: Vendor = { name: COMPANY.name, address: COMPANY.address, uid: COMPANY.uid, bankName: '' };
const compact = (date: string) => date.replaceAll('-', '');

function scenario(seed: number): Scenario {
  const rnd = mulberry32(seed);
  /** A CHF amount between lo and hi, on 5 Rappen. */
  const between = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 20) / 20;

  const payments: Payment[] = [];
  const manual: ManualEntry[] = [];
  const phone: { date: string; gross: number }[] = [];
  /** What the owner paid privately in each month, refunded at its end. */
  const outlays = new Map<number, number>();

  /** An expense the owner paid with his own card: an Auslage on 2451, with its receipt. */
  const paidPrivately = (date: string, vendor: Vendor, account: string, vatCode: string, text: string, doc: Parameters<typeof invoice>[0]) => {
    const d = invoice(doc);
    const m = Number(date.slice(5, 7));
    outlays.set(m, r2((outlays.get(m) ?? 0) + d.total));
    payments.push({
      bank: PAID_PRIVATELY, date, text: `Auslage ${COMPANY.owner}: ${vendor.name}`,
      parts: [{ counterparty: vendor.bankName, text, legs: [{ account, amount: -d.total, vatCode, text }], doc: d }],
    });
  };

  /** One of our own invoices, paid by the client on `paid`. `bookedAs` is a booking mistake: the code the entry got instead. */
  const sale = (o: {
    bank: string; paid: string; client: Vendor; date: string; number: string; title: string;
    currency: 'CHF' | 'EUR'; net: number; vatCode: 'V81' | 'V0-E'; text: string; key?: string; bookedAs?: 'V0-E';
  }) => {
    const swiss = o.vatCode === 'V81';
    const gross = swiss ? r2(o.net * 1.081) : o.net;
    const doc = invoice({
      file: `${compact(o.date)}-muster-consulting-rechnung-${o.number}`, vendor: SELF, to: o.client, date: o.date,
      title: 'Rechnung', number: o.number, description: `Rechnung ${o.number} an ${o.client.name}`, currency: o.currency,
      items: [{ text: o.title, gross, rate: swiss ? 8.1 : 0 }],
      footer: swiss ? ['Zahlbar innert 30 Tagen']
        : ['Leistungsort beim Empfänger (Art. 8 Abs. 1 MWSTG): ohne Schweizer MWST', 'Reverse charge: VAT to be accounted for by the recipient'],
      kind: 'sales-record',
    });
    payments.push({
      bank: o.bank, date: o.paid,
      text: o.bank === 'wise-eur' ? `Received money from ${o.client.bankName}` : `Gutschrift ${o.client.name}`,
      parts: [{
        counterparty: o.client.bankName, reference: `Rechnung ${o.number}`, text: `Rechnung ${o.number}`,
        legs: [{ account: '3400', amount: gross, vatCode: o.bookedAs ?? o.vatCode, text: o.text, ...(o.key ? { key: o.key } : {}) }],
        doc,
      }],
    });
  };

  for (let m = 1; m <= 9; m++) {
    const mm = pad(m);
    const month = `${MONTHS[m - 1]} ${YEAR}`;
    const quarter = Math.ceil(m / 3);

    // The retainer of the main Swiss client, billed at the start of each month. In March its payment
    // was booked V0-E by mistake, the code of the foreign clients; the correction is booked in April.
    sale({
      bank: 'raiffeisen', paid: bankDay(isoDate(2026, m, 20)), client: VENDORS.treuhand, date: bankDay(isoDate(2026, m, 2)),
      number: `${YEAR}-${mm}1`, title: `Beratungsmandat IT-Sicherheit, ${month}`, currency: 'CHF', net: 6000,
      vatCode: 'V81', text: `Beispiel Treuhand, Beratungsmandat ${month}`, ...(m === 3 ? { key: 'treuhand-march', bookedAs: 'V0-E' as const } : {}),
    });

    // Salary: the owner is the company's only employee. The gross salary is the expense on 5000:
    // the bank pays the net, the employee's deductions wait on 2270 until the Ausgleichskasse and
    // the pension fund are paid (examples/cases/salary-payment.yaml).
    const payday = bankDay(isoDate(2026, m, 25));
    payments.push({
      bank: 'raiffeisen', date: payday, text: `Lohnzahlung ${COMPANY.owner}`,
      parts: [{
        counterparty: COMPANY.owner.toUpperCase(), reference: `Lohn ${month}`, text: `Nettolohn ${month}`,
        legs: [{ account: '5000', amount: -NET_SALARY, text: `Lohn ${month} netto, ${COMPANY.owner}` }],
        noReceipt: `Lohn ${month} gemäss Lohnabrechnung: brutto ${chf(GROSS_SALARY)}, netto ${chf(NET_SALARY)}; Lohn ist kein Entgelt im Sinne der MWST`,
      }],
    });
    manual.push({
      date: payday, debit: '5000', credit: '2270', amount: EMPLOYEE_DEDUCTIONS, key: `salary-deductions-${mm}`,
      text: `Lohn ${month} Abzüge Arbeitnehmer (AHV/IV/EO, ALV, BVG), ${COMPANY.owner}`,
    });

    // Coworking desk, billed monthly with MWST.
    const coworkDate = bankDay(isoDate(2026, m, 1));
    payments.push({
      bank: 'raiffeisen', date: coworkDate, text: 'Zahlung Muster Coworking AG',
      parts: [{
        counterparty: VENDORS.coworking.bankName, reference: qrReference(`3011${YEAR}${mm}`), text: `Rechnung CW-${YEAR}-${mm}`,
        legs: [{ account: '6000', amount: -450, vatCode: 'I81', text: `Muster Coworking, Fixdesk ${month}` }],
        doc: invoice({
          file: `${compact(coworkDate)}-muster-coworking-${YEAR}-${mm}`, vendor: VENDORS.coworking, date: isoDate(2026, m, 1),
          title: 'Rechnung', number: `CW-${YEAR}-${mm}`, description: `Muster Coworking, Fixdesk ${month}`, currency: 'CHF',
          items: [{ text: `Fixdesk inkl. Internet und Sitzungszimmer, ${month}`, gross: 450, rate: 8.1 }],
        }),
      }],
    });

    // Mobile phone and subscription, by eBill. Partly private, see the Eigenverbrauch in June.
    const phoneGross = between(84, 112);
    const phoneDate = bankDay(isoDate(2026, m, 18));
    phone.push({ date: phoneDate, gross: phoneGross });
    payments.push({
      bank: 'raiffeisen', date: phoneDate, text: 'eBill Muster Telecom AG',
      parts: [{
        counterparty: VENDORS.telecom.bankName, reference: qrReference(`8642${YEAR}${mm}`), text: `Rechnung MT-${YEAR}${mm}`,
        legs: [{ account: '6510', amount: -phoneGross, vatCode: 'I81', text: `Muster Telecom, Mobile-Abo ${month}` }],
        doc: invoice({
          file: `${YEAR}${mm}05-muster-telecom-${YEAR}-${mm}`, vendor: VENDORS.telecom, date: isoDate(2026, m, 5),
          title: 'Rechnung', number: `MT-${YEAR}${mm}`, description: `Muster Telecom, Mobile-Abo ${month}`, currency: 'CHF',
          items: [{ text: `Mobile-Abo unlimitiert, ${month}`, gross: 69, rate: 8.1 }, { text: 'Roaming und Zusatzleistungen', gross: r2(phoneGross - 69), rate: 8.1 }],
        }),
      }],
    });

    // A US software service without Swiss MWST: Bezugsteuer (MWSTG Art. 45), paid by debit card in CHF.
    const labsDate = bankDay(isoDate(2026, m, 7));
    payments.push({
      bank: 'raiffeisen', date: labsDate, text: 'Debitkarte SAMPLE LABS INC SEATTLE',
      parts: [{
        counterparty: VENDORS.sampleLabs.bankName, text: 'SAMPLE LABS INC SEATTLE',
        legs: [{ account: '6570', amount: -24.6, vatCode: 'B81-1', text: `Sample Labs, Code-Hosting ${month} (Bezugsteuer)` }],
        doc: invoice({
          file: `${compact(labsDate)}-sample-labs-invoice-${YEAR}-${mm}`, vendor: VENDORS.sampleLabs, date: labsDate,
          title: 'Invoice', number: `SL-${YEAR}${mm}-311`, description: `Sample Labs, code hosting ${month}`, currency: 'CHF',
          items: [{ text: `Team plan, ${month}`, gross: 24.6, rate: 0 }],
          footer: ['Charged in CHF to your card. Reverse charge: VAT to be accounted for by the recipient'],
        }),
      }],
    });

    // A German software service registered for Swiss MWST, billed in EUR, paid from Wise EUR.
    const swDate = bankDay(isoDate(2026, m, 10));
    payments.push({
      bank: 'wise-eur', date: swDate, text: 'Card transaction of 32.43 EUR issued by Beispiel Software BERLIN',
      parts: [{
        counterparty: VENDORS.beispielSoftware.bankName, text: 'Card transaction of 32.43 EUR issued by Beispiel Software BERLIN',
        legs: [{ account: '6570', amount: -32.43, vatCode: 'I81', text: `Beispiel Software, Projektplanung ${month}` }],
        doc: invoice({
          file: `${compact(swDate)}-beispiel-software-rechnung-${YEAR}-${mm}`, vendor: VENDORS.beispielSoftware, date: swDate,
          title: 'Rechnung', number: `BS-${YEAR}-${mm}77`, description: `Beispiel Software, Projektplanung ${month}`, currency: 'EUR',
          items: [{ text: `Projektplanung Pro, ${month}`, gross: 32.43, rate: 8.1 }],
          footer: ['Schweizer MWST gemäss Registrierung CHE-579.246.813'],
        }),
      }],
    });

    // Train tickets to clients, paid privately with the owner's card.
    const sbbDate = bankDay(isoDate(2026, m, 12));
    const sbbGross = between(38, 96);
    paidPrivately(sbbDate, VENDORS.sbb, '6640', 'I81', `SBB, Billett Bern–Zürich retour (Kundenbesuch ${month})`, {
      file: `${compact(sbbDate)}-sbb-billett`, vendor: VENDORS.sbb, date: sbbDate,
      title: 'Quittung', number: `${compact(sbbDate)}-4471`, description: 'SBB, Billett Bern–Zürich retour', currency: 'CHF',
      items: [{ text: 'Billett Bern–Zürich HB retour, 2. Klasse', gross: sbbGross, rate: 8.1 }],
    });

    // A business lunch with a client every quarter, paid privately.
    if (m % 3 === 2) {
      const lunchDate = bankDay(isoDate(2026, m, 16));
      const lunch = between(96, 168);
      paidPrivately(lunchDate, VENDORS.restaurant, '6641', 'I81', `Restaurant Beispielhof, Geschäftsessen mit Kunde (${month})`, {
        file: `${compact(lunchDate)}-restaurant-beispielhof`, vendor: VENDORS.restaurant, date: lunchDate,
        title: 'Quittung', number: `${compact(lunchDate)}-27`, description: 'Restaurant Beispielhof, Geschäftsessen', currency: 'CHF',
        items: [{ text: '2 Mittagsmenüs und Getränke', gross: lunch, rate: 8.1 }],
        footer: ['Bewirtung: Geschäftsessen mit Muster Logistik AG, Projekt Lagersteuerung'],
      });
    }

    // Social insurance: the Ausgleichskasse's Akontorechnung each quarter (AHV/IV/EO/ALV, employer
    // and employee share together). The employee's share clears 2270, the employer's is the expense.
    if (m % 3 === 0) {
      const ahvDate = bankDay(isoDate(2026, m, 26));
      payments.push({
        bank: 'raiffeisen', date: ahvDate, text: 'Zahlung Ausgleichskasse Muster',
        parts: [{
          counterparty: VENDORS.ausgleichskasse.bankName, reference: qrReference(`7700${YEAR}${quarter}`), text: `Akonto AHV Q${quarter} ${YEAR}`,
          legs: [
            { account: '2270', amount: -AHV_EMPLOYEE_QUARTER, text: `Ausgleichskasse, Beiträge Arbeitnehmer Q${quarter} ${YEAR}` },
            { account: '5700', amount: -r2(AHV_AKONTO - AHV_EMPLOYEE_QUARTER), text: `Ausgleichskasse, Beiträge Arbeitgeber Q${quarter} ${YEAR}` },
          ],
          doc: invoice({
            file: `${YEAR}${mm}05-ausgleichskasse-akonto-q${quarter}`, vendor: VENDORS.ausgleichskasse, date: isoDate(2026, m, 5),
            title: 'Akontorechnung', number: `AK-${YEAR}-Q${quarter}`, description: `Ausgleichskasse, Akonto Q${quarter} ${YEAR}`, currency: 'CHF',
            items: [
              { text: `AHV/IV/EO 10.6% auf Lohnsumme Q${quarter} von ${chf(3 * GROSS_SALARY)}`, gross: 2734.8, rate: 0 },
              { text: `ALV 2.2% auf Lohnsumme Q${quarter}`, gross: 567.6, rate: 0 },
              { text: 'Familienausgleichskasse und Verwaltungskosten', gross: 310.2, rate: 0 },
            ],
            footer: ['Sozialversicherungsbeiträge unterliegen nicht der MWST'],
          }),
        }],
      });
    }

    // Occupational pension (BVG), billed per quarter in advance.
    if (m % 3 === 1) {
      const bvgDate = bankDay(isoDate(2026, m, 15));
      payments.push({
        bank: 'raiffeisen', date: bvgDate, text: 'Zahlung Muster Sammelstiftung BVG',
        parts: [{
          counterparty: VENDORS.vorsorge.bankName, reference: qrReference(`5720${YEAR}${quarter}`), text: `BVG-Beitrag Q${quarter} ${YEAR}`,
          legs: [
            { account: '2270', amount: -3 * BVG_EMPLOYEE, text: `Muster Sammelstiftung, BVG Arbeitnehmer Q${quarter} ${YEAR}` },
            { account: '5720', amount: -r2(BVG_QUARTER - 3 * BVG_EMPLOYEE), text: `Muster Sammelstiftung, BVG Arbeitgeber Q${quarter} ${YEAR}` },
          ],
          doc: invoice({
            file: `${YEAR}${mm}02-muster-sammelstiftung-bvg-q${quarter}`, vendor: VENDORS.vorsorge, date: isoDate(2026, m, 2),
            title: 'Beitragsrechnung', number: `BVG-${YEAR}-Q${quarter}`, description: `Muster Sammelstiftung, BVG Q${quarter} ${YEAR}`, currency: 'CHF',
            items: [{ text: `Spar- und Risikobeiträge Q${quarter}, Arbeitgeber und Arbeitnehmer`, gross: BVG_QUARTER, rate: 0 }],
            footer: ['Vorsorgebeiträge unterliegen nicht der MWST'],
          }),
        }],
      });
    }

    // Bank fees at quarter end.
    if (m % 3 === 0) {
      payments.push({
        bank: 'raiffeisen', date: isoDate(2026, m, lastDay(m)), text: 'Kontoführungsgebühren',
        parts: [{ counterparty: 'Raiffeisenbank Bern-Muster', text: `Kontoführung ${quarter}. Quartal`, legs: [{ account: '6940', amount: -12, text: `Raiffeisen, Kontoführung Q${quarter}` }], noReceipt: 'Bankspesen laut Kontoauszug' }],
      });
    }
  }

  // Accident and sickness-pay insurance (UVG, KTG): one yearly premium in January. Insurance is exempt from MWST.
  payments.push({
    bank: 'raiffeisen', date: '2026-01-20', text: 'Zahlung Muster Versicherungen AG',
    parts: [{
      counterparty: VENDORS.versicherung.bankName, reference: qrReference(`5730${YEAR}`), text: `Prämienrechnung ${YEAR}`,
      legs: [
        { account: '5730', amount: -486, text: `Muster Versicherungen, UVG-Prämie ${YEAR}` },
        { account: '5740', amount: -912, text: `Muster Versicherungen, KTG-Prämie ${YEAR}` },
      ],
      doc: invoice({
        file: '20260105-muster-versicherungen-praemie-2026', vendor: VENDORS.versicherung, date: '2026-01-05',
        title: 'Prämienrechnung', number: `PR-${YEAR}-5501`, description: `Muster Versicherungen, UVG und KTG ${YEAR}`, currency: 'CHF',
        items: [{ text: `Unfallversicherung UVG ${YEAR}`, gross: 486, rate: 0 }, { text: `Krankentaggeld KTG ${YEAR}`, gross: 912, rate: 0 }],
        footer: ['Versicherungsprämien sind von der MWST ausgenommen (Art. 21 Abs. 2 Ziff. 18 MWSTG)'],
      }),
    }],
  });

  // A second Swiss client billed per project. The March invoice was paid only in May: on the
  // cash basis its MWST belongs to Q2, the quarter the money came in.
  for (const [date, paid, number, title] of [
    ['2026-02-06', '2026-03-09', '2026-022', 'Konzept Lagersteuerung'],
    ['2026-03-24', '2026-05-12', '2026-032', 'Umsetzung Lagersteuerung, Phase 1'],
    ['2026-07-03', '2026-07-31', '2026-072', 'Umsetzung Lagersteuerung, Phase 2'],
  ] as const) {
    sale({
      bank: 'raiffeisen', paid, client: VENDORS.logistik, date, number, title, currency: 'CHF',
      net: between(4200, 9800), vatCode: 'V81', text: `Muster Logistik, ${title}`,
    });
  }

  // Foreign clients: services to a recipient abroad are taxed where the recipient is (Art. 8 Abs. 1
  // MWSTG), so no Swiss MWST; they are declared as Leistungen im Ausland (Ziffer 221).
  for (const [date, paid, number] of [['2026-01-09', '2026-02-02', '2026-013'], ['2026-04-08', '2026-04-29', '2026-043'], ['2026-07-07', '2026-07-28', '2026-073']] as const) {
    sale({
      bank: 'wise-eur', paid, client: VENDORS.maschinenbau, date, number, title: 'Sicherheitsaudit Fernwartung, Quartalspauschale',
      currency: 'EUR', net: 3800, vatCode: 'V0-E', text: 'Muster Maschinenbau, Sicherheitsaudit (Leistung im Ausland)',
    });
  }
  for (const [date, paid, number] of [['2026-05-04', '2026-06-01', '2026-054'], ['2026-08-03', '2026-09-01', '2026-084']] as const) {
    sale({
      bank: 'raiffeisen', paid, client: VENDORS.analytics, date, number, title: 'Code review and threat model', currency: 'CHF',
      net: between(2400, 3600), vatCode: 'V0-E', text: 'Example Analytics, Code-Review (Leistung im Ausland)',
    });
  }

  // A new laptop. At CHF 2’349 and years of use it is an asset (1520), not an expense: the
  // ~CHF 150 line of AGENTS.md separates small items that are expensed at once from things like
  // this, which are capitalized and written down at year end. The input tax is deducted in full now.
  payments.push({
    bank: 'raiffeisen', date: '2026-02-16', text: 'Debitkarte Digitec Galaxus AG',
    parts: [{
      counterparty: VENDORS.digitec.bankName, text: 'Digitec Galaxus AG Zuerich',
      legs: [{ account: '1520', amount: -2349, vatCode: 'I81', text: 'Digitec Galaxus, Laptop 14" (aktiviert)' }],
      doc: invoice({
        file: '20260216-digitec-galaxus-laptop', vendor: VENDORS.digitec, date: '2026-02-16',
        title: 'Rechnung', number: '118455012', description: 'Digitec Galaxus, Laptop', currency: 'CHF',
        items: [{ text: 'Laptop 14", 32 GB, 1 TB', gross: 2199, rate: 8.1 }, { text: 'USB-C Dockingstation', gross: 150, rate: 8.1 }],
      }),
    }],
  });

  // Specialist books, paid privately. Books carry the reduced rate of 2.6%, so the input tax is I26.
  for (const [date, gross, title] of [['2026-03-11', 89.0, 'Fachbuch Netzwerksicherheit'], ['2026-06-09', 64.5, 'Fachbuch Cloud-Architektur']] as const) {
    paidPrivately(date, VENDORS.buchhandlung, '6500', 'I26', `Buchhandlung Muster, ${title}`, {
      file: `${compact(date)}-buchhandlung-muster`, vendor: VENDORS.buchhandlung, date,
      title: 'Quittung', number: `${compact(date)}-12`, description: `Buchhandlung Muster, ${title}`, currency: 'CHF',
      items: [{ text: title, gross, rate: 2.6 }],
    });
  }

  // A course: education is exempt from MWST (Art. 21 Abs. 2 Ziff. 11), so the invoice shows none and there is no input tax.
  payments.push({
    bank: 'raiffeisen', date: '2026-05-20', text: 'Zahlung Muster Akademie',
    parts: [{
      counterparty: VENDORS.akademie.bankName, reference: qrReference('58102026051'), text: 'Rechnung KURS-2026-118',
      legs: [{ account: '5810', amount: -1200, vatCode: 'I0', text: 'Muster Akademie, Kurs Cloud Security (von der MWST ausgenommen)' }],
      doc: invoice({
        file: '20260504-muster-akademie-kurs', vendor: VENDORS.akademie, date: '2026-05-04',
        title: 'Rechnung', number: 'KURS-2026-118', description: 'Muster Akademie, Kurs Cloud Security', currency: 'CHF',
        items: [{ text: 'Kurs Cloud Security, 3 Tage', gross: 1200, rate: 0 }],
        footer: ['Bildungsleistung, von der MWST ausgenommen (Art. 21 Abs. 2 Ziff. 11 MWSTG)'],
      }),
    }],
  });

  // Parking at a client: the ticket was lost. No receipt, no input tax (I0).
  payments.push({
    bank: 'raiffeisen', date: '2026-08-19', text: 'Debitkarte PARKHAUS BEISPIEL BERN',
    parts: [{
      counterparty: VENDORS.parkhaus.bankName, text: 'PARKHAUS BEISPIEL BERN',
      legs: [{ account: '6640', amount: -24, vatCode: 'I0', text: 'Parkhaus Beispiel, Kundenbesuch (Beleg fehlt)' }],
    }],
  });

  // The owner's outlays come back at the end of each month in one transfer.
  for (const [m, total] of [...outlays].sort(([a], [b]) => a - b)) {
    const month = `${MONTHS[m - 1]} ${YEAR}`;
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 28)), text: `Spesenrückerstattung ${COMPANY.owner}`,
      parts: [{
        counterparty: COMPANY.owner.toUpperCase(), reference: `Spesen ${month}`, text: `Spesenabrechnung ${month}`,
        legs: [{ account: '2451', amount: -total, text: `Spesenrückerstattung ${month}, ${COMPANY.owner}` }],
        noReceipt: `Spesenabrechnung ${month}: die Belege hängen an den einzelnen Auslagen`,
      }],
    });
  }

  // 20% of the mobile phone in Q2 was private use.
  const q2Phone = r2(phone.filter((p) => p.date >= '2026-04-01' && p.date <= '2026-06-30').reduce((s, p) => s + p.gross, 0));
  const privateShare = r2(q2Phone * 0.2);
  const march = 6486;
  manual.push(
    {
      date: '2026-04-14', debit: '3400', credit: '3400', amount: march, vatCode: '-V0-E', corrects: '2026-Q1', key: 'treuhand-storno',
      text: 'Stornobuchung zu Buchung {id:treuhand-march} (Q1): Beispiel Treuhand Rechnung 2026-031 war als Leistung im Ausland (V0-E) gebucht',
    },
    {
      date: '2026-04-14', debit: '3400', credit: '3400', amount: march, vatCode: 'V81', corrects: '2026-Q1', key: 'treuhand-rebook',
      text: 'Korrekturbuchung zu Buchung {id:treuhand-march} (Q1): Beispiel Treuhand Rechnung 2026-031 ist eine Inlandleistung, 8.1% MWST',
    },
    {
      date: '2026-06-30', debit: '2451', credit: '6510', amount: privateShare, vatCode: 'K81-B', key: 'private-phone',
      text: `Eigenverbrauch: Privatanteil Mobiltelefon Q2 2026, 20% von CHF ${chf(q2Phone)} (${COMPANY.owner})`,
    },
  );

  const tax = taxIn(march, 8.1);
  const correctionCases: CorrectionCase[] = [{
    id: '2026-Q1-treuhand-inland',
    period: '2026-Q1',
    title: 'Inlandleistung Beispiel Treuhand als Auslandleistung deklariert',
    wrong: 'Die Zahlung der Beispiel Treuhand AG (Zürich) für die Rechnung 2026-031 lief mit V0-E (Ziffer 221) statt V81: CHF 6’486.00 ohne Steuer deklariert.',
    fix: `Storno -V0-E und Neubuchung V81 über je CHF ${chf(march)} vom 14.04.2026 mit corrects 2026-Q1, Steuer CHF ${chf(tax)} nachdeklariert; die Buchung vom März bleibt wie eingereicht.`,
    originalEntryIds: ['treuhand-march'],
    correctionEntryIds: ['treuhand-storno', 'treuhand-rebook'],
    source: 'receipts/20260302-muster-consulting-rechnung-2026-031.pdf',
  }];

  return {
    payments,
    manual,
    correctionCases,
    taxPayment: (payable) => ({
      bank: 'raiffeisen', date: '2026-05-27', text: 'Zahlung Eidg. Steuerverwaltung ESTV',
      parts: [{
        counterparty: VENDORS.estv.bankName, reference: qrReference(`461${COMPANY.uid.replace(/\D/g, '')}12026`), text: 'MWST 1. Quartal 2026',
        legs: [{ account: '2201', amount: -payable, text: 'ESTV, MWST-Abrechnung Q1 2026' }],
        noReceipt: 'MWST-Abrechnung Q1 2026, filings/2026/mwst-ech0217-2026-Q1.xml',
      }],
    }),
    // The Korrekturabrechnung (form 0535) of Q1 declares the rebooked Treuhand invoice; the ESTV bills the difference.
    correctionPayment: (difference) => ({
      bank: 'raiffeisen', date: '2026-06-15', text: 'Zahlung Eidg. Steuerverwaltung ESTV',
      parts: [{
        counterparty: VENDORS.estv.bankName, reference: qrReference(`535${COMPANY.uid.replace(/\D/g, '')}12026`), text: 'MWST Korrekturabrechnung 1. Quartal 2026',
        legs: [{ account: '2201', amount: -difference, text: 'ESTV, Korrekturabrechnung (0535) Q1 2026' }],
        noReceipt: 'Korrekturabrechnung Q1 2026: Differenz laut Formular 0535 (MWST-Tab, Korrekturabrechnung)',
      }],
    }),
  };
}

const KNOWLEDGE: Record<string, string> = {
  'customers/beispiel-treuhand.yaml': `# A private client: no public file, so this one is the whole business.
id: beispiel-treuhand
name: Beispiel Treuhand AG
match:
  tx: ["beispiel treuhand"]
  uid: ["CHE-318.642.975"]
accounts: ["3400"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-treuhand-retainer
        when: the monthly payment of Beispiel Treuhand AG for the consulting retainer
        then: '3400 Ertrag Beratung, V81 (a Swiss client: the service is taxed in Switzerland, never V0-E)'
        source: correction 2026-Q1-treuhand-inland, decision 2026-04-14
    precedents: []
`,
  'suppliers/sample-labs.yaml': `# A foreign software service without Swiss MWST.
id: sample-labs
name: Sample Labs Inc.
match:
  tx: ["sample labs"]
  file: ['^\\\\d{8}-sample-labs']
accounts: ["6570"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-sample-labs-bezugsteuer
        when: the monthly Sample Labs card charge
        then: '6570 Informatik, Software, B81-1 (Bezugsteuer: a service from abroad without Swiss MWST)'
        source: decision 2026-01-10
    precedents: []
`,
};

export const consulting: Demo = {
  dir: 'demo-consulting',
  company: COMPANY,
  closedThrough: '2026-03-31',
  filed: { period: '2026-Q1', generationTime: '2026-04-24T16:40:00' },
  banks: BANKS,
  ownerAccount: { account: '2451', label: `Kontokorrent ${COMPANY.owner}` },
  openingOther: OPENING_OTHER,
  accounts: ACCOUNTS,
  vendors: VENDORS,
  knowledge: KNOWLEDGE,
  scenario,
};
