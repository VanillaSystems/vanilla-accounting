/**
 * The story of Schreinerei Beispiel GmbH, a fictional joinery in St. Gallen on the net tax rate
 * method (Saldosteuersatz 4.5 %, half-yearly returns), for January to September 2026 (the shape
 * every demo shares is in tools/demo/kit.ts). Sales are booked gross with F1, the approved rate's
 * code; purchases carry no VAT code, whatever their receipt shows; a foreign software service
 * owes Bezugsteuer. The first half year is filed; one June sale was booked as an export by
 * mistake and is corrected in July.
 *
 * Everyone here is invented, and every invented UID has a wrong check digit, so it can never
 * belong to a real company. The rate, its label and its activity code are made up as well.
 */
import type { CorrectionCase } from '../../src/types/index.js';
import type { VatSetup } from '../../src/workspace/vat-setup.js';
import {
  YEAR, bankDay, chf, invoicesFor, isoDate, lastDay, MONTHS, mulberry32, pad, qrReference, r2,
  type Company, type Demo, type ManualEntry, type Payment, type Scenario, type StatementBank, type Vendor,
} from './kit.js';

const COMPANY: Company = {
  name: 'Schreinerei Beispiel GmbH',
  uid: 'CHE-135.246.357',
  owner: 'Reto Beispiel',
  address: ['Werkstrasse 12', '9000 St. Gallen'],
};

/** The rate the ESTV approved (invented): 4.5 % on the gross turnover of the joinery, with its activity code. */
const VAT: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] };

const BANKS: Record<'raiffeisen', StatementBank> = {
  raiffeisen: {
    bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank Raiffeisen',
    iban: 'CH1180808000000000003', institution: 'Raiffeisenbank Beispiel', opening: 31000,
  },
};

/** The machines and the van at their book values, and the share capital. */
const OPENING_OTHER: Record<string, number> = { '1500': 24000, '1530': 18000, '2800': 20000 };

const ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ['1020', 'Bank Raiffeisen'],
  ['1500', 'Maschinen und Apparate'],
  ['1530', 'Fahrzeuge'],
  ['2000', 'Verbindlichkeiten aus Lieferungen und Leistungen'],
  ['2200', 'Geschuldete MWST'],
  ['2201', 'Abrechnungskonto MWST'],
  ['2270', 'Sozialversicherungen und Vorsorgeeinrichtungen'],
  ['2451', 'Kontokorrent Gesellschafter'],
  ['2800', 'Stammkapital'],
  ['2970', 'Gewinnvortrag'],
  ['3400', 'Ertrag Schreinerarbeiten'],
  ['4000', 'Materialaufwand Holz und Beschläge'],
  ['5000', 'Lohnaufwand'],
  ['5700', 'AHV, IV, EO, ALV'],
  ['5730', 'Unfallversicherung'],
  ['6000', 'Mietaufwand Werkstatt'],
  ['6100', 'Unterhalt und Reparaturen Maschinen'],
  ['6200', 'Fahrzeugaufwand'],
  ['6300', 'Sachversicherungen'],
  ['6510', 'Telefon, Internet'],
  ['6570', 'Informatik, Software'],
  ['6940', 'Bankspesen'],
];

const VENDORS = {
  holz: { name: 'Beispiel Holzhandel AG', address: ['Sägeweg 4', '9015 St. Gallen'], uid: 'CHE-246.802.469', bankName: 'BEISPIEL HOLZHANDEL AG' },
  beschlaege: { name: 'Muster Beschläge GmbH', address: ['Industriestrasse 9', '9200 Gossau'], uid: 'CHE-357.913.579', bankName: 'MUSTER BESCHLAEGE GMBH' },
  garage: { name: 'Garage Beispiel AG', address: ['Zürcher Strasse 200', '9014 St. Gallen'], uid: 'CHE-468.024.680', bankName: 'GARAGE BEISPIEL AG' },
  telecom: { name: 'Muster Telecom AG', address: ['Funkweg 1', '3000 Bern'], uid: 'CHE-864.209.753', bankName: 'Muster Telecom AG' },
  tools: { name: 'Example Tools Inc.', address: ['200 Sample Road', 'Portland, OR 97201', 'USA'], bankName: 'EXAMPLE TOOLS INC PORTLAND' },
  versicherung: { name: 'Muster Versicherungen AG', address: ['Policenweg 7', '8004 Zürich'], bankName: 'Muster Versicherungen AG' },
  ausgleichskasse: { name: 'Ausgleichskasse Muster', address: ['Postfach', '9001 St. Gallen'], bankName: 'Ausgleichskasse Muster' },
  vermieter: { name: 'Beispiel Liegenschaften AG', address: ['Hauptstrasse 1', '9000 St. Gallen'], bankName: 'BEISPIEL LIEGENSCHAFTEN AG' },
  immobilien: { name: 'Beispiel Immobilien AG', address: ['Bahnhofplatz 2', '9000 St. Gallen'], uid: 'CHE-579.135.791', bankName: 'BEISPIEL IMMOBILIEN AG' },
  muster: { name: 'Familie Muster', address: ['Rosenweg 5', '9008 St. Gallen'], bankName: 'MUSTER HANS UND VRENI' },
  rheinpark: { name: 'Hotel Rheinpark AG', address: ['Städtle 21', '9490 Vaduz', 'Liechtenstein'], bankName: 'HOTEL RHEINPARK AG VADUZ' },
  moebelhaus: { name: 'Möbelhaus Beispiel GmbH', address: ['Beispielstrasse 3', '80331 München', 'Deutschland'], bankName: 'MOEBELHAUS BEISPIEL GMBH' },
  estv: { name: 'Eidg. Steuerverwaltung ESTV', address: ['Schwarztorstrasse 50', '3003 Bern'], bankName: 'Eidg. Steuerverwaltung ESTV' },
} satisfies Record<string, Vendor>;

/** One employee's salary: AHV/IV/EO 5.3 % and ALV 1.1 % are the employee's deductions; the Ausgleichskasse bills both halves quarterly. */
const GROSS_SALARY = 6200;
const AHV_EMPLOYEE = r2(GROSS_SALARY * 0.064);
const NET_SALARY = r2(GROSS_SALARY - AHV_EMPLOYEE);
const AHV_AKONTO = 2604;

/** The June mandate's gross amount: booked V0 by mistake, so the storno and the rebooking name the same figure. */
const JUNE = 3480;

const invoice = invoicesFor(COMPANY);
/** The company as the issuer of its own invoices: it bills at the statutory rate, whatever its own method. */
const SELF: Vendor = { name: COMPANY.name, address: COMPANY.address, uid: COMPANY.uid, bankName: '' };
const compact = (date: string) => date.replaceAll('-', '');

function scenario(seed: number): Scenario {
  const rnd = mulberry32(seed);
  const between = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 20) / 20;
  const payments: Payment[] = [];
  const manual: ManualEntry[] = [];

  /** One of our invoices, paid by the client: the gross amount on 3400 with the net rate's code F1, or V0 for an export. */
  const sale = (o: { paid: string; client: Vendor; date: string; number: string; title: string; gross: number; vatCode: 'F1' | 'V0'; text: string; key?: string; bookedAs?: 'V0' }) => {
    const exported = o.vatCode === 'V0';
    const doc = invoice({
      file: `${compact(o.date)}-schreinerei-beispiel-rechnung-${o.number}`, vendor: SELF, to: o.client, date: o.date,
      title: 'Rechnung', number: o.number, description: `Rechnung ${o.number} an ${o.client.name}`, currency: 'CHF',
      items: [{ text: o.title, gross: o.gross, rate: exported ? 0 : 8.1 }],
      footer: exported ? ['Ausfuhrlieferung nach Deutschland, Ausfuhrnachweis liegt bei: ohne Schweizer MWST'] : ['Zahlbar innert 30 Tagen'],
      kind: 'sales-record',
    });
    payments.push({
      bank: 'raiffeisen', date: o.paid, text: `Gutschrift ${o.client.name}`,
      parts: [{ counterparty: o.client.bankName, reference: `Rechnung ${o.number}`, text: `Rechnung ${o.number}`, legs: [{ account: '3400', amount: o.gross, vatCode: o.bookedAs ?? o.vatCode, text: o.text, ...(o.key ? { key: o.key } : {}) }], doc }],
    });
  };

  for (let m = 1; m <= 9; m++) {
    const mm = pad(m);
    const month = `${MONTHS[m - 1]} ${YEAR}`;
    const quarter = Math.ceil(m / 3);

    // The property manager's monthly maintenance mandate. June's payment was booked V0 by mistake, as if exported; the correction follows in July.
    sale({
      paid: bankDay(isoDate(2026, m, 22)), client: VENDORS.immobilien, date: bankDay(isoDate(2026, m, 3)), number: `${YEAR}-${mm}1`,
      title: `Unterhalt Liegenschaften, ${month}`, gross: m === 6 ? JUNE : between(2000, 4500), vatCode: 'F1', text: `Beispiel Immobilien, Unterhalt ${month}`,
      ...(m === 6 ? { key: 'immobilien-june', bookedAs: 'V0' as const } : {}),
    });

    // Wood and fittings: the receipts show 8.1 % MWST, but on the net tax rate method there is no input tax, so no code.
    const holzDate = bankDay(isoDate(2026, m, 8));
    const holz = between(900, 2600);
    payments.push({
      bank: 'raiffeisen', date: holzDate, text: 'Zahlung Beispiel Holzhandel AG',
      parts: [{
        counterparty: VENDORS.holz.bankName, reference: qrReference(`4000${YEAR}${mm}`), text: `Rechnung HH-${YEAR}-${mm}`,
        legs: [{ account: '4000', amount: -holz, text: `Beispiel Holzhandel, Massivholz und Platten ${month}` }],
        doc: invoice({
          file: `${compact(holzDate)}-beispiel-holzhandel-${YEAR}-${mm}`, vendor: VENDORS.holz, date: isoDate(2026, m, 2),
          title: 'Rechnung', number: `HH-${YEAR}-${mm}`, description: `Beispiel Holzhandel, Holz ${month}`, currency: 'CHF',
          items: [{ text: `Massivholz Eiche und Dreischichtplatten, ${month}`, gross: holz, rate: 8.1 }],
        }),
      }],
    });

    // Salary of the one employee, and the deductions waiting on 2270 (examples/cases/salary-payment.yaml).
    const payday = bankDay(isoDate(2026, m, 25));
    payments.push({
      bank: 'raiffeisen', date: payday, text: 'Lohnzahlung Marco Beispiel',
      parts: [{ counterparty: 'MARCO BEISPIEL', reference: `Lohn ${month}`, text: `Nettolohn ${month}`, legs: [{ account: '5000', amount: -NET_SALARY, text: `Lohn ${month} netto, Marco Beispiel` }], noReceipt: `Lohn ${month} gemäss Lohnabrechnung: brutto ${chf(GROSS_SALARY)}, netto ${chf(NET_SALARY)}` }],
    });
    manual.push({ date: payday, debit: '5000', credit: '2270', amount: AHV_EMPLOYEE, key: `salary-deductions-${mm}`, text: `Lohn ${month} Abzüge Arbeitnehmer (AHV/IV/EO, ALV), Marco Beispiel` });

    // Workshop rent, by standing order, no receipt but the lease.
    payments.push({
      bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 1)), text: 'Dauerauftrag Miete Werkstatt',
      parts: [{ counterparty: VENDORS.vermieter.bankName, text: `Miete Werkstatt ${month}`, legs: [{ account: '6000', amount: -2300, text: `Beispiel Liegenschaften, Miete Werkstatt ${month}` }], noReceipt: 'Miete laut Mietvertrag, von der MWST ausgenommen' }],
    });

    // Phone and internet.
    const telDate = bankDay(isoDate(2026, m, 18));
    const tel = between(72, 98);
    payments.push({
      bank: 'raiffeisen', date: telDate, text: 'eBill Muster Telecom AG',
      parts: [{
        counterparty: VENDORS.telecom.bankName, reference: qrReference(`8642${YEAR}${mm}`), text: `Rechnung MT-${YEAR}${mm}`,
        legs: [{ account: '6510', amount: -tel, text: `Muster Telecom, Telefon und Internet ${month}` }],
        doc: invoice({ file: `${YEAR}${mm}05-muster-telecom-${YEAR}-${mm}`, vendor: VENDORS.telecom, date: isoDate(2026, m, 5), title: 'Rechnung', number: `MT-${YEAR}${mm}`, description: `Muster Telecom, Telefon ${month}`, currency: 'CHF', items: [{ text: `Business-Abo, ${month}`, gross: tel, rate: 8.1 }] }),
      }],
    });

    // Fuel for the van, by debit card.
    const fuelDate = bankDay(isoDate(2026, m, 14));
    const fuel = between(180, 320);
    payments.push({
      bank: 'raiffeisen', date: fuelDate, text: 'Debitkarte GARAGE BEISPIEL AG',
      parts: [{
        counterparty: VENDORS.garage.bankName, text: 'GARAGE BEISPIEL AG ST. GALLEN',
        legs: [{ account: '6200', amount: -fuel, text: `Garage Beispiel, Diesel Lieferwagen ${month}` }],
        doc: invoice({ file: `${compact(fuelDate)}-garage-beispiel-tanken`, vendor: VENDORS.garage, date: fuelDate, title: 'Quittung', number: `${compact(fuelDate)}-88`, description: 'Garage Beispiel, Diesel', currency: 'CHF', items: [{ text: 'Diesel', gross: fuel, rate: 8.1 }] }),
      }],
    });

    // A US design software without Swiss MWST: Bezugsteuer (MWSTG Art. 45) is owed on the net tax rate method as well, at the statutory rate.
    const toolsDate = bankDay(isoDate(2026, m, 11));
    payments.push({
      bank: 'raiffeisen', date: toolsDate, text: 'Debitkarte EXAMPLE TOOLS INC PORTLAND',
      parts: [{
        counterparty: VENDORS.tools.bankName, text: 'EXAMPLE TOOLS INC PORTLAND',
        legs: [{ account: '6570', amount: -29, vatCode: 'B81-1', text: `Example Tools, CAD-Abo ${month} (Bezugsteuer)` }],
        doc: invoice({ file: `${compact(toolsDate)}-example-tools-invoice-${YEAR}-${mm}`, vendor: VENDORS.tools, date: toolsDate, title: 'Invoice', number: `ET-${YEAR}${mm}-204`, description: `Example Tools, CAD subscription ${month}`, currency: 'CHF', items: [{ text: `CAD Pro, ${month}`, gross: 29, rate: 0 }], footer: ['Charged in CHF. Reverse charge: VAT to be accounted for by the recipient'] }),
      }],
    });

    // The Ausgleichskasse's quarterly Akonto: the employee's share clears 2270, the employer's is the expense.
    if (m % 3 === 0) {
      payments.push({
        bank: 'raiffeisen', date: bankDay(isoDate(2026, m, 26)), text: 'Zahlung Ausgleichskasse Muster',
        parts: [{
          counterparty: VENDORS.ausgleichskasse.bankName, reference: qrReference(`7700${YEAR}${quarter}`), text: `Akonto AHV Q${quarter} ${YEAR}`,
          legs: [
            { account: '2270', amount: -r2(3 * AHV_EMPLOYEE), text: `Ausgleichskasse, Beiträge Arbeitnehmer Q${quarter} ${YEAR}` },
            { account: '5700', amount: -r2(AHV_AKONTO - 3 * AHV_EMPLOYEE), text: `Ausgleichskasse, Beiträge Arbeitgeber Q${quarter} ${YEAR}` },
          ],
          doc: invoice({ file: `${YEAR}${mm}05-ausgleichskasse-akonto-q${quarter}`, vendor: VENDORS.ausgleichskasse, date: isoDate(2026, m, 5), title: 'Akontorechnung', number: `AK-${YEAR}-Q${quarter}`, description: `Ausgleichskasse, Akonto Q${quarter} ${YEAR}`, currency: 'CHF', items: [{ text: `AHV/IV/EO/ALV und FAK auf Lohnsumme Q${quarter}`, gross: AHV_AKONTO, rate: 0 }], footer: ['Sozialversicherungsbeiträge unterliegen nicht der MWST'] }),
        }],
      });
      payments.push({
        bank: 'raiffeisen', date: isoDate(2026, m, lastDay(m)), text: 'Kontoführungsgebühren',
        parts: [{ counterparty: 'Raiffeisenbank Beispiel', text: `Kontoführung ${quarter}. Quartal`, legs: [{ account: '6940', amount: -15, text: `Raiffeisen, Kontoführung Q${quarter}` }], noReceipt: 'Bankspesen laut Kontoauszug' }],
      });
    }
  }

  // Insurance for the year, in January: exempt from MWST.
  payments.push({
    bank: 'raiffeisen', date: '2026-01-19', text: 'Zahlung Muster Versicherungen AG',
    parts: [{
      counterparty: VENDORS.versicherung.bankName, reference: qrReference(`6300${YEAR}`), text: `Prämienrechnung ${YEAR}`,
      legs: [{ account: '6300', amount: -1860, text: `Muster Versicherungen, Betriebshaftpflicht und Sachversicherung ${YEAR}` }, { account: '5730', amount: -1240, text: `Muster Versicherungen, UVG-Prämie ${YEAR}` }],
      doc: invoice({ file: '20260105-muster-versicherungen-praemie-2026', vendor: VENDORS.versicherung, date: '2026-01-05', title: 'Prämienrechnung', number: `PR-${YEAR}-7731`, description: `Muster Versicherungen, Prämien ${YEAR}`, currency: 'CHF', items: [{ text: `Betriebshaftpflicht und Sachversicherung ${YEAR}`, gross: 1860, rate: 0 }, { text: `Unfallversicherung UVG ${YEAR}`, gross: 1240, rate: 0 }], footer: ['Versicherungsprämien sind von der MWST ausgenommen (Art. 21 Abs. 2 Ziff. 18 MWSTG)'] }),
    }],
  });

  // Fittings for the kitchen job, and a machine repair: purchases gross, no code.
  for (const [date, number, gross, text] of [['2026-02-12', 'MB-2026-118', 1420, 'Beschläge und Schubladensysteme Küche Muster'], ['2026-04-09', 'MB-2026-342', 680, 'Beschläge Hotelzimmer Vaduz']] as const) {
    payments.push({
      bank: 'raiffeisen', date, text: 'Zahlung Muster Beschläge GmbH',
      parts: [{ counterparty: VENDORS.beschlaege.bankName, reference: qrReference(number.replace(/\D/g, '')), text: `Rechnung ${number}`, legs: [{ account: '4000', amount: -gross, text: `Muster Beschläge, ${text}` }], doc: invoice({ file: `${compact(date)}-muster-beschlaege-${number.toLowerCase()}`, vendor: VENDORS.beschlaege, date, title: 'Rechnung', number, description: `Muster Beschläge, ${text}`, currency: 'CHF', items: [{ text, gross, rate: 8.1 }] }) }],
    });
  }
  payments.push({
    bank: 'raiffeisen', date: '2026-04-21', text: 'Zahlung Garage Beispiel AG',
    parts: [{ counterparty: VENDORS.garage.bankName, reference: qrReference('61002026421'), text: 'Rechnung GB-2026-0419', legs: [{ account: '6100', amount: -1850, text: 'Garage Beispiel, Service Lieferwagen und Reparatur Hebebühne' }], doc: invoice({ file: '20260415-garage-beispiel-service', vendor: VENDORS.garage, date: '2026-04-15', title: 'Rechnung', number: 'GB-2026-0419', description: 'Garage Beispiel, Service', currency: 'CHF', items: [{ text: 'Service Lieferwagen 60’000 km', gross: 1850, rate: 8.1 }] }) }],
  });

  // Private and foreign clients: a kitchen, hotel room furniture for Vaduz (Liechtenstein is in the Swiss VAT territory: domestic), an export to Munich (V0).
  sale({ paid: '2026-03-16', client: VENDORS.muster, date: '2026-02-27', number: '2026-022', title: 'Küche in Eiche, Planung und Montage', gross: 12400, vatCode: 'F1', text: 'Familie Muster, Küche' });
  sale({ paid: '2026-05-29', client: VENDORS.rheinpark, date: '2026-05-08', number: '2026-051', title: 'Zimmermöbel Hotel, 6 Zimmer', gross: 8600, vatCode: 'F1', text: 'Hotel Rheinpark, Zimmermöbel (Vaduz, Inland)' });
  sale({ paid: '2026-08-14', client: VENDORS.moebelhaus, date: '2026-07-24', number: '2026-071', title: 'Massivholztische, Lieferung nach München', gross: 6800, vatCode: 'V0', text: 'Möbelhaus Beispiel, Tische (Ausfuhr)' });

  // The owner's private share of the van: a correction of the year-end kind is not booked here; the first half year is filed as it stood.
  // The June payment of Beispiel Immobilien was booked V0 (an export) by mistake; the storno and the rebooking in July correct H1.
  const june = JUNE;
  manual.push(
    { date: '2026-07-10', debit: '3400', credit: '3400', amount: june, vatCode: '-V0', corrects: '2026-H1', key: 'immobilien-storno', text: 'Stornobuchung zu Buchung {id:immobilien-june} (H1): Beispiel Immobilien Rechnung 2026-061 war als Ausfuhr (V0) gebucht' },
    { date: '2026-07-10', debit: '3400', credit: '3400', amount: june, vatCode: 'F1', corrects: '2026-H1', key: 'immobilien-rebook', text: 'Korrekturbuchung zu Buchung {id:immobilien-june} (H1): Beispiel Immobilien Rechnung 2026-061 ist Inlandumsatz zum Saldosteuersatz (F1)' },
  );
  const correctionCases: CorrectionCase[] = [{
    id: '2026-H1-immobilien-inland',
    period: '2026-H1',
    title: 'Inlandumsatz Beispiel Immobilien als Ausfuhr deklariert',
    wrong: `Die Juni-Zahlung der Beispiel Immobilien AG (St. Gallen) für die Rechnung 2026-061 lief mit V0 (Ziffer 220) statt F1: CHF ${chf(june)} ohne Steuer deklariert.`,
    fix: `Storno -V0 und Neubuchung F1 über je CHF ${chf(june)} vom 10.07.2026 mit corrects 2026-H1, Steuer CHF ${chf(r2(june * 0.045))} nachdeklariert; die Buchung vom Juni bleibt wie eingereicht.`,
    originalEntryIds: ['immobilien-june'],
    correctionEntryIds: ['immobilien-storno', 'immobilien-rebook'],
    source: 'receipts/20260603-schreinerei-beispiel-rechnung-2026-061.pdf',
  }];

  return {
    payments,
    manual,
    correctionCases,
    taxPayment: (payable) => ({
      bank: 'raiffeisen', date: '2026-08-27', text: 'Zahlung Eidg. Steuerverwaltung ESTV',
      parts: [{ counterparty: VENDORS.estv.bankName, reference: qrReference(`461${COMPANY.uid.replace(/\D/g, '')}12026`), text: 'MWST 1. Semester 2026', legs: [{ account: '2201', amount: -payable, text: 'ESTV, MWST-Abrechnung H1 2026 (Saldosteuersatz)' }], noReceipt: 'MWST-Abrechnung H1 2026, filings/2026/mwst-ech0217-2026-H1.xml' }],
    }),
    correctionPayment: (difference) => ({
      bank: 'raiffeisen', date: '2026-09-15', text: 'Zahlung Eidg. Steuerverwaltung ESTV',
      parts: [{ counterparty: VENDORS.estv.bankName, reference: qrReference(`535${COMPANY.uid.replace(/\D/g, '')}12026`), text: 'MWST Korrekturabrechnung 1. Semester 2026', legs: [{ account: '2201', amount: -difference, text: 'ESTV, Korrekturabrechnung (0535) H1 2026' }], noReceipt: 'Korrekturabrechnung H1 2026: Differenz laut Formular 0535 (MWST-Tab, Korrekturabrechnung)' }],
    }),
  };
}

const KNOWLEDGE: Record<string, string> = {
  'customers/beispiel-immobilien.yaml': `# A private client: no public file, so this one is the whole business.
id: beispiel-immobilien
name: Beispiel Immobilien AG
match:
  tx: ["beispiel immobilien"]
  uid: ["CHE-579.135.791"]
accounts: ["3400"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-immobilien-unterhalt
        when: the monthly payment of Beispiel Immobilien AG for the maintenance mandate
        then: '3400 Ertrag Schreinerarbeiten, F1 (a Swiss client: the net tax rate on the gross amount, never V0)'
        source: correction 2026-H1-immobilien-inland, decision 2026-07-10
    precedents: []
`,
  'suppliers/beispiel-holzhandel.yaml': `# The wood supplier: its receipts show 8.1 % MWST, which this firm does not deduct (Saldosteuersatz).
id: beispiel-holzhandel
name: Beispiel Holzhandel AG
match:
  tx: ["beispiel holzhandel"]
  uid: ["CHE-246.802.469"]
accounts: ["4000"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-holzhandel-material
        then: { account: "4000", vat: none }
        source: decision 2026-01-10
    precedents: []
`,
};

export const schreinerei: Demo = {
  dir: 'demo-schreinerei',
  company: COMPANY,
  vat: VAT,
  closedThrough: '2026-06-30',
  filed: { period: '2026-H1', generationTime: '2026-08-20T09:00:00' },
  banks: BANKS,
  ownerAccount: { account: '2451', label: `Kontokorrent ${COMPANY.owner}` },
  openingOther: OPENING_OTHER,
  accounts: ACCOUNTS,
  vendors: VENDORS,
  knowledge: KNOWLEDGE,
  scenario,
};

