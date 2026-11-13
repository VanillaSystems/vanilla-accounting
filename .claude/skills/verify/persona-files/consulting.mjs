// Made-up files of a one-person consultancy (Kälin Advisory GmbH, Zug) for persona tests: the owner is
// its only employee, bills Swiss clients at 8.1 % and one client in Germany in EUR (a service abroad,
// Ziffer 221), pays software from abroad without Swiss VAT (Bezugsteuer), pays some costs privately and
// gets them back each month, and uses the company phone privately too. A CHF account at a cantonal
// bank and a Wise EUR account, each as camt.053; the firm's own invoices as PDFs from the tool he
// wrote them in; and the two files he is likely to drop first: the bank's PDF statement of the same
// account, and the company credit card's statement, which the app does not import (docs/getting-started.md, Limits).
import { ibanOf, ibanAny, beBban, uidOf, spaced, n, r2, chf, addDays, bankDay, dmy, camt, table, css, tillPhoto, estvRates, vatBoxes, payroll, balanceSheet } from './kit.mjs';

const REPO = new URL('../../../../', import.meta.url).pathname;
const MONTH = { '07': 'Juli', '08': 'August', '09': 'September' };
const MONTH_EN = { '07': 'July', '08': 'August', '09': 'September' };
const sum = (xs, f = (x) => x) => r2(xs.reduce((s, x) => s + f(x), 0));

export default function build() {
  const rate = estvRates(REPO);
  const FIRM = { name: 'Kälin Advisory GmbH', street: 'Baarerstrasse 41', city: '6300 Zug', owner: 'Matthias Kälin' };
  const IBAN = ibanOf('00787', ['0090', '5512', '6601'].join(''));
  const WISE = ibanAny('BE', beBban(['967', '4402', '187'].join('')));
  const UID = uidOf(['2295', '4410'].join(''));
  const CAMT = 'camt053_ZugerKB_Q3-2026.xml';
  // Named as Wise names its statement export, like the demos' Wise statements.
  const CAMT_WISE = `uuid_statement_${['4402', '1870'].join('')}_EUR_2026-07-01_2026-09-30.xml`;
  const to = (c) => `${c.name}<br>${c.street}<br>${c.city}${c.country ? `<br>${c.country}` : ''}`;
  const self = `${FIRM.name}<br>${FIRM.street}<br>${FIRM.city}`;

  const zkb = [], wise = [];
  const entries = [];
  const becomes = [];
  const add = (list, date, dir, amount, who, text, code, should, extra = {}) => { const r = { date, dir, amount: r2(amount), who, text, code, should, ...extra }; list.push(r); return r; };
  const docs = {};

  // ─── Own invoices (written in another tool) and the clients' payments ───────────
  const CLIENTS = {
    braendli: { name: 'Brändli Logistik AG', street: 'Industriestrasse 12', city: '6343 Rotkreuz', iban: ibanOf('00787', ['0011', '4420', '9001'].join('')) },
    seeblick: { name: 'Stiftung Seeblick', street: 'Seestrasse 3', city: '6300 Zug', iban: ibanOf('00700', ['1150', '0098', '7712'].join('')) },
    nordwerk: { name: 'Nordwerk Systems GmbH', street: 'Chausseestrasse 88', city: '10115 Berlin', country: 'Deutschland', vat: 'DE 318 445 902' },
    huwiler: { name: 'Praxis Dr. Huwiler', street: 'Dorfplatz 2', city: '6330 Cham', iban: ibanOf('00787', ['0033', '1287', '5560'].join('')) },
  };
  const invoices = [
    { no: 'RE-2026-031', client: 'braendli', date: '2026-07-01', text: 'Beratungsmandat Prozessdigitalisierung, Juli 2026', net: 7200 },
    { no: 'RE-2026-032', client: 'seeblick', date: '2026-07-20', text: 'Strategie-Workshop Stiftungsrat (2 Tage) inkl. Vorbereitung und Bericht', net: 11500 },
    { no: 'RE-2026-033', client: 'braendli', date: '2026-08-03', text: 'Beratungsmandat Prozessdigitalisierung, August 2026', net: 7200 },
    { no: 'RE-2026-034', client: 'nordwerk', date: '2026-08-10', text: 'IT governance review, remote, 10 days', net: 9400, ccy: 'EUR' },
    { no: 'RE-2026-035', client: 'huwiler', date: '2026-08-28', text: 'Beratung Praxissoftware, Evaluation und Offertvergleich', net: 1650 },
    { no: 'RE-2026-036', client: 'braendli', date: '2026-09-01', text: 'Beratungsmandat Prozessdigitalisierung, September 2026', net: 7200 },
  ];
  for (const i of invoices) {
    const c = CLIENTS[i.client]; i.ccy ??= 'CHF';
    i.swiss = i.ccy === 'CHF'; i.vat = i.swiss ? r2(i.net * 0.081) : 0; i.total = r2(i.net + i.vat);
    docs[`Rechnung_${i.no}_${c.name.split(' ')[0].replace('ä', 'ae')}.pdf`] = `<style>${css}</style><h1>${FIRM.name}</h1><div class=small>${FIRM.street}, ${FIRM.city}<br>MWST-Nr. ${UID} MWST</div><p style="margin-top:30px">${to(c)}</p><h2>${i.swiss ? 'Rechnung' : 'Invoice'} ${i.no}</h2><p>${i.swiss ? 'Datum' : 'Date'}: ${dmy(i.date)}</p><table><tr><th>${i.swiss ? 'Leistung' : 'Service'}</th><th class=r>${i.swiss ? 'Betrag' : 'Amount'} ${i.ccy}</th></tr><tr><td>${i.text}</td><td class=r>${n(i.net)}</td></tr>${i.swiss ? `<tr><td>MWST 8.1%</td><td class=r>${n(i.vat)}</td></tr>` : ''}<tr><th>Total ${i.ccy}</th><th class=r>${n(i.total)}</th></tr></table>${i.swiss ? `<p>Zahlbar innert 30 Tagen auf IBAN ${spaced(IBAN)}, Zuger Kantonalbank, mit Vermerk ${i.no}.</p>` : `<p>Customer VAT ID ${c.vat}. Place of supply at the recipient (Art. 8 para. 1 Swiss VAT Act): no Swiss VAT. Reverse charge.</p><p>Payable within 30 days to IBAN ${spaced(WISE)} (Wise Europe SA), reference ${i.no}.</p>`}`;
  }
  const inv = (no) => invoices.find((i) => i.no === no);
  // The June retainer, invoiced in Q2 (not among the files), paid in July: on the cash basis a sale of Q3.
  const june = { no: 'RE-2026-028', total: r2(7200 * 1.081) };
  add(zkb, '2026-07-03', 'CRDT', june.total, CLIENTS.braendli.name, `Rechnung ${june.no}`, 'PMNT/RCDT/DMCT', `1020 / 3400, V81: the June invoice ${june.no}, not among the files (the sale question: Inland 8.1 %)`, { iban: CLIENTS.braendli.iban });
  entries.push(['2026-07-03', 'V81', june.total, `${june.no} Brändli (June)`]);
  for (const [no, day, text] of [['RE-2026-031', '2026-07-27', 'Rechnung RE-2026-031'], ['RE-2026-033', '2026-08-25', 'RE-2026-033 Mandat August'], ['RE-2026-032', '2026-08-14', 'Zahlung Workshop Juli'], ['RE-2026-035', '2026-09-22', 'RE-2026-035']]) {
    const i = inv(no), c = CLIENTS[i.client];
    add(zkb, day, 'CRDT', i.total, c.name, text, 'PMNT/RCDT/DMCT', `1020 / 3400, V81 (its invoice ${no}${text.includes(no) ? ', named in the payment' : ', found by the amount: the payment names no number'})`, { iban: c.iban });
    entries.push([day, 'V81', i.total, `${no} ${c.name}`]);
  }
  const nw = inv('RE-2026-034');
  const nwDay = '2026-09-03';
  const nwChf = r2(nw.total * rate('EUR', nwDay));
  add(wise, nwDay, 'CRDT', nw.total, 'NORDWERK SYSTEMS GMBH', 'RE-2026-034', 'PMNT/RCDT/DMCT', `1021 / 3400 EUR ${n(nw.total)} = CHF ${chf(nwChf)} at the ESTV rate of ${dmy(nwDay)}, V0-E (a service abroad, Ziffer 221; the sale question: Ausland)`, { info: `Received money from NORDWERK SYSTEMS GMBH with reference RE-2026-034` });
  entries.push([nwDay, 'V0-E', nwChf, 'RE-2026-034 Nordwerk (EUR)']);

  // ─── Salary and social insurance: payslips, the Akonto bill and the pension fund's bill (kit.mjs payroll) ───
  const pay = payroll({
    firm: FIRM, months: ['07', '08', '09'], people: [{ name: FIRM.owner, role: 'Geschäftsführer', gross: 9500, bvg: 290 }],
    ahvFund: { name: 'Ausgleichskasse Zug', addr: 'Baarerstrasse 11, 6300 Zug', no: 'AK-2026-Q3-4471', file: 'Ausgleichskasse' },
    bvgFund: { name: 'Vorsorgestiftung Zentralschweiz', addr: 'Pilatusstrasse 20, 6003 Luzern', no: 'BVG-26-3-0918', file: 'BVG' },
    ahvDate: '2026-07-06', bvgDate: '2026-07-02',
  });
  Object.assign(docs, pay.docs);
  const me = pay.people[0];
  for (const m of ['07', '08', '09']) add(zkb, bankDay(`2026-${m}-25`), 'DBIT', me.net, FIRM.owner, `Lohn ${MONTH[m]} 2026`, 'PMNT/ICDT/SALA', `the net wage of the payslip: (a) or (b) under «Wages and contributions», no VAT code`);
  add(zkb, '2026-09-25', 'DBIT', pay.ahv.total, 'Ausgleichskasse Zug', 'Akonto Q3 2026 AK-2026-Q3-4471', 'PMNT/ICDT/DMCT', `(a) 2270 CHF ${chf(pay.ahv.employee)} + 5700 CHF ${chf(pay.ahv.employer)}, or (b) 5700 whole; no VAT code`);
  add(zkb, '2026-07-10', 'DBIT', pay.bvg.total, 'Vorsorgestiftung Zentralschweiz', 'Beitrag Q3 2026 BVG-26-3-0918', 'PMNT/ICDT/DMCT', `(a) 2270 CHF ${chf(pay.bvg.employee)} + 5720 CHF ${chf(pay.bvg.employer)}, or (b) 5720 whole; no VAT code`);

  // ─── Rent, phone, software ──────────────────────────────────────────────
  const cowork = { name: 'Werkplatz Coworking AG', addr: 'Gubelstrasse 9, 6300 Zug', uid: uidOf(['3381', '0572'].join('')), iban: ibanOf('00787', ['0077', '1203', '3340'].join('')) };
  const telco = { name: 'Alpentel AG', addr: 'Hardturmstrasse 161, 8005 Zürich', uid: uidOf(['4019', '2236'].join('')), iban: ibanOf('00700', ['2290', '0045', '1180'].join('')) };
  const phones = { '07': 84.35, '08': 97.20, '09': 79.90 };
  const swissBill = (v, no, date, rows, foot = 'Zahlbar innert 30 Tagen.') => { const total = sum(rows, (r) => r[1]); const vat = r2((total * 8.1) / 108.1); return `<style>${css}</style><h1>${v.name}</h1><div class=small>${v.addr}<br>MWST-Nr. ${v.uid} MWST</div><p style="margin-top:30px">${self}</p><h2>Rechnung ${no}</h2><p>Datum: ${dmy(date)}</p><table>${rows.map((r) => `<tr><td>${r[0]}</td><td class=r>${n(r[1])}</td></tr>`).join('')}<tr><th>Total CHF inkl. MWST</th><th class=r>${n(total)}</th></tr><tr><td class=small>darin MWST 8.1%</td><td class=r>${n(vat)}</td></tr></table><p>${foot}${v.iban ? ` IBAN ${spaced(v.iban)}` : ''}</p>`; };
  for (const m of ['07', '08', '09']) {
    const day = bankDay(`2026-${m}-01`);
    docs[`Werkplatz_Rechnung_2026-${m}.pdf`] = swissBill(cowork, `WP-26-${m}-118`, addDays(`2026-${m}-01`, -5), [[`Fixdesk ${MONTH[m]} 2026, inkl. Internet und Sitzungszimmer 4 h`, 520]]);
    add(zkb, day, 'DBIT', 520, cowork.name, `Rechnung WP-26-${m}-118`, 'PMNT/ICDT/DMCT', '6000 / 1020, I81 (its Werkplatz invoice)', { iban: cowork.iban });
    entries.push([day, 'I81', 520, `Werkplatz ${m}`]);
    const pday = bankDay(`2026-${m}-20`);
    docs[`Alpentel_Rechnung_2026-${m}.pdf`] = swissBill(telco, `AT-${m}26-55107`, `2026-${m}-05`, [[`Mobile Business Unlimited, ${MONTH[m]} 2026`, 69.00], ['Roaming und Zusatzleistungen', r2(phones[m] - 69)]], 'eBill.');
    add(zkb, pday, 'DBIT', phones[m], telco.name, `eBill AT-${m}26-55107`, 'PMNT/ICDT/DMCT', '6510 / 1020, I81; with the wish «Telefon zur Hälfte privat»: half on 2451 without VAT (private: 50), or whole with own use (K81-B)', { iban: telco.iban });
    entries.push([pday, 'I81', phones[m], `Alpentel ${m}`]);
  }

  const cloud = { usd: 48.00 };
  const planwise = { chf: 34.00, uid: uidOf(['5163', '9902'].join('')) };
  for (const m of ['07', '08', '09']) {
    const cday = bankDay(`2026-${m}-04`);
    const cchf = r2(cloud.usd * rate('USD', cday) * 1.0175);
    docs[`Cloudhaven_Invoice_2026-${m}.pdf`] = `<style>${css}</style><h1>Cloudhaven Inc.</h1><div class=small>500 Howard Street, San Francisco, CA 94105, USA</div><p style="margin-top:30px">${self}<br>Switzerland</p><h2>Invoice CH-${m}26-90311</h2><p>Date: ${dmy(cday)} &nbsp; Paid by card ending 8823</p><table><tr><td>Cloud hosting, Team plan, ${MONTH_EN[m]} 2026</td><td class=r>USD ${n(cloud.usd)}</td></tr><tr><td>Tax</td><td class=r>USD 0.00</td></tr><tr><th>Total USD</th><th class=r>${n(cloud.usd)}</th></tr></table><p class=small>Cloudhaven Inc. is not registered for VAT in Switzerland. The customer accounts for any VAT due.</p>`;
    add(zkb, cday, 'DBIT', cchf, 'CLOUDHAVEN INC', `Debitkarte 8823 CLOUDHAVEN INC SAN FRANCISCO USD ${n(cloud.usd)}`, 'PMNT/CCRD/POSD', `6570 / 1020, B81-1 (Bezugsteuer: a service from abroad without Swiss VAT, 383 and 405)`);
    entries.push([cday, 'B81-1', cchf, `Cloudhaven ${m}`]);
    const pday = bankDay(`2026-${m}-08`);
    docs[`Planwise_Rechnung_2026-${m}.pdf`] = `<style>${css}</style><h1>Planwise GmbH</h1><div class=small>Torstrasse 140, 10119 Berlin, Deutschland<br>MWST-Nr. ${planwise.uid} MWST</div><p style="margin-top:30px">${self}</p><h2>Rechnung PW-26${m}-2207</h2><p>Datum: ${dmy(pday)} &nbsp; bezahlt mit Karte ****8823</p><table><tr><td>Planwise Pro, ${MONTH[m]} 2026</td><td class=r>${n(r2(planwise.chf / 1.081))}</td></tr><tr><td>Schweizer MWST 8.1%</td><td class=r>${n(r2(planwise.chf - r2(planwise.chf / 1.081)))}</td></tr><tr><th>Total CHF</th><th class=r>${n(planwise.chf)}</th></tr></table>`;
    add(zkb, pday, 'DBIT', planwise.chf, 'PLANWISE GMBH', 'Debitkarte 8823 PLANWISE GMBH BERLIN', 'PMNT/CCRD/POSD', '6570 / 1020, I81: a German vendor registered for Swiss VAT (its invoice shows 8.1 % and a CHE number), no Bezugsteuer');
    entries.push([pday, 'I81', planwise.chf, `Planwise ${m}`]);
  }

  // Wise writes a card payment with its text in AddtlTxInf and no remittance (as the demos' Wise statements).
  const WISE_CARD = { remittance: false, info: undefined };
  // On the Wise EUR card: an Irish tool in EUR and a US tool in USD (Wise takes the EUR), both without Swiss VAT.
  const notably = { eur: 12.00 };
  const promptly = { usd: 20.00 };
  for (const m of ['07', '08', '09']) {
    const nday = bankDay(`2026-${m}-13`);
    docs[`Notably_Receipt_2026-${m}.pdf`] = `<style>${css}</style><h1>Notably Ltd</h1><div class=small>12 Fenian Street, Dublin 2, Ireland &nbsp; VAT IE 3344556 K</div><p style="margin-top:30px">${self}<br>Switzerland</p><h2>Receipt NB-${m}26-4471</h2><p>Date: ${dmy(nday)}</p><table><tr><td>Notably Plus, monthly</td><td class=r>EUR ${n(notably.eur)}</td></tr><tr><td>VAT (customer outside the EU)</td><td class=r>EUR 0.00</td></tr><tr><th>Total EUR</th><th class=r>${n(notably.eur)}</th></tr></table>`;
    add(wise, nday, 'DBIT', notably.eur, 'Notably Ltd', `Card transaction of ${n(notably.eur)} EUR issued by Notably Ltd DUBLIN`, 'PMNT/ICDT/DMCT', `6570 / 1021 EUR ${n(notably.eur)} = CHF ${chf(r2(notably.eur * rate('EUR', nday)))}, B81-1`, WISE_CARD);
    entries.push([nday, 'B81-1', r2(notably.eur * rate('EUR', nday)), `Notably ${m}`]);
    const pday = bankDay(`2026-${m}-21`);
    const eur = r2((promptly.usd * rate('USD', pday)) / rate('EUR', pday) * 1.0041);
    docs[`Promptly_Invoice_2026-${m}.pdf`] = `<style>${css}</style><h1>Promptly AI, Inc.</h1><div class=small>88 Mission Street, San Francisco, CA 94105, USA</div><p style="margin-top:30px">${self}<br>Switzerland</p><h2>Invoice PA-${m}26-1180</h2><p>Date: ${dmy(pday)}</p><table><tr><td>Promptly Pro, 1 seat, ${MONTH_EN[m]} 2026</td><td class=r>USD ${n(promptly.usd)}</td></tr><tr><th>Total USD</th><th class=r>${n(promptly.usd)}</th></tr></table><p class=small>No sales tax or VAT charged.</p>`;
    add(wise, pday, 'DBIT', eur, 'Promptly AI', `Card transaction of ${n(promptly.usd)} USD issued by Promptly AI SAN FRANCISCO`, 'PMNT/ICDT/DMCT', `6570 / 1021 EUR ${n(eur)} = CHF ${chf(r2(eur * rate('EUR', pday)))}, B81-1 (the receipt is in USD: the statement's «${n(promptly.usd)} USD» matches it)`, WISE_CARD);
    entries.push([pday, 'B81-1', r2(eur * rate('EUR', pday)), `Promptly ${m}`]);
  }

  // ─── The company credit card: one settlement on the bank, the items only on its statement ─────
  const card = { day: '2026-09-10', from: '2026-08-01', to: '2026-08-31' };
  const linkly = { usd: 180.00, day: '2026-08-07' };
  linkly.chf = r2(linkly.usd * rate('USD', linkly.day) * 1.0);
  linkly.fx = r2(linkly.chf * 0.0175);
  const hotel = { day: '2026-08-19', lines: [['Übernachtung Einzelzimmer 18.–19.08.', 158.00], ['Frühstück', 0], ['Kurtaxe', 6.00]] };
  hotel.total = sum(hotel.lines, (l) => l[1]);
  card.total = r2(linkly.chf + linkly.fx + hotel.total);
  docs['Linkly_Ads_Invoice_2026-08.pdf'] = `<style>${css}</style><h1>Linkly Ads Ireland Ltd</h1><div class=small>Wilton Place, Dublin 2, Ireland</div><p style="margin-top:30px">${self}<br>Switzerland</p><h2>Invoice LA-2608-77012</h2><p>Date: ${dmy(linkly.day)} &nbsp; Charged to Visa ****3307</p><table><tr><td>Sponsored posts, campaign «Prozessdigitalisierung KMU», 01.–07.08.2026</td><td class=r>USD ${n(linkly.usd)}</td></tr><tr><td>VAT: reverse charge, customer to account</td><td class=r>USD 0.00</td></tr><tr><th>Total USD</th><th class=r>${n(linkly.usd)}</th></tr></table>`;
  docs['Hotel_Pilatusblick_Rechnung.pdf'] = `<style>${css}</style><h1>Hotel Pilatusblick</h1><div class=small>Pilatusstrasse 30, 6003 Luzern<br>MWST-Nr. ${uidOf(['6610', '3348'].join(''))} MWST</div><p style="margin-top:30px">${FIRM.owner}<br>${self}</p><h2>Rechnung 26-08-4471</h2><p>Datum: ${dmy(hotel.day)} &nbsp; bezahlt mit Visa ****3307</p><table><tr><td>Übernachtung Einzelzimmer 18.–19.08.2026, inkl. Frühstück</td><td class=r>158.00</td></tr><tr><td>Kurtaxe (ohne MWST)</td><td class=r>6.00</td></tr><tr><th>Total CHF</th><th class=r>${n(hotel.total)}</th></tr><tr><td class=small>darin MWST 3.8% (Beherbergung) auf 158.00</td><td class=r>${n(r2((158 * 3.8) / 103.8))}</td></tr></table>`;
  docs['Alpencard_Abrechnung_August_2026.pdf'] = `<style>${css}</style><h1>Alpencard AG</h1><div class=small>Kreditkartenabrechnung Visa Business ****3307</div><p style="margin-top:30px">${self}</p><h2>Abrechnung ${dmy(card.from)} – ${dmy(card.to)}</h2><table><tr><th>Datum</th><th>Beschreibung</th><th class=r>Betrag CHF</th></tr><tr><td>${dmy(linkly.day)}</td><td>LINKLY ADS DUBLIN IE, USD ${n(linkly.usd)}</td><td class=r>${n(linkly.chf)}</td></tr><tr><td>${dmy(linkly.day)}</td><td>Bearbeitungsgebühr Fremdwährung 1.75%</td><td class=r>${n(linkly.fx)}</td></tr><tr><td>${dmy(hotel.day)}</td><td>HOTEL PILATUSBLICK LUZERN</td><td class=r>${n(hotel.total)}</td></tr><tr><th colspan=2>Total zu Ihren Lasten, Belastung per LSV am ${dmy(card.day)}</th><th class=r>${n(card.total)}</th></tr></table>`;
  add(zkb, card.day, 'DBIT', card.total, 'Alpencard AG', 'Kartenabrechnung August 2026 LSV', 'PMNT/IDDT/ESDD', `split by the card statement's lines (see «The credit card»): Linkly Ads CHF ${chf(linkly.chf)} B81-1, the card fee CHF ${chf(linkly.fx)} on 6940 without a code, the hotel CHF ${chf(hotel.total)} on 6640 (158.00 with I38 only when the hotel's bill is linked to that line, the Kurtaxe 6.00 without VAT)`);
  entries.push([linkly.day, 'B81-1', linkly.chf, 'Linkly Ads (card)'], [hotel.day, 'I38', 158.00, 'Hotel Pilatusblick (card)']);

  // ─── Paid privately, reimbursed at the month's end ────────────────────────────
  const sbb = (day, route, price) => `<style>${css}</style><h1>SBB CFF FFS</h1><div class=small>Schweizerische Bundesbahnen SBB, Hilfikerstrasse 1, 3000 Bern 65<br>MWST-Nr. CHE-102.909.703 MWST</div><h2>Billett / Quittung</h2><p>Reisedatum: ${dmy(day)} &nbsp; Reisender: ${FIRM.owner}</p><table><tr><td>${route}, 2. Klasse, Halbtax</td><td class=r>${n(price)}</td></tr><tr><th>Total CHF</th><th class=r>${n(price)}</th></tr><tr><td class=small>inkl. MWST 8.1%</td><td class=r>${n(r2((price * 8.1) / 108.1))}</td></tr></table><p class=small>Bezahlt mit Mastercard ****1150 (privat)</p>`;
  const outlays = {
    '07': [
      { file: 'SBB_Billett_Zug-Basel.pdf', day: '2026-07-08', what: 'SBB Zug–Basel SBB retour', amount: 72.40, code: 'I81', account: '6640', html: sbb('2026-07-08', 'Zug – Basel SBB und zurück', 72.40) },
      { file: 'IMG_7710.jpg', day: '2026-07-15', what: 'Ristorante Lago, lunch with Brändli Logistik', amount: 146.50, code: 'I81', account: '6641', photo: tillPhoto({ shop: 'Ristorante Lago Zug', uid: `${uidOf(['7024', '1186'].join(''))} MWST`, lines: [['Menu del giorno 2x', 64.00], ['Vitello tonnato', 28.50], ['Acqua minerale 2x', 12.00], ['Vino bianco 3dl', 27.00], ['Caffè 2x', 15.00]], total: 146.50, vat: [[8.1, r2((146.50 * 8.1) / 108.1)]], paid: 'Mastercard ****1150', date: '2026-07-15', time: '13:42', tilt: 1.5, bg: '#3d4a52' }) },
    ],
    '08': [
      { file: 'SBB_Billett_Zug-Bern.pdf', day: '2026-08-19', what: 'SBB Zug–Bern retour', amount: 58.00, code: 'I81', account: '6640', html: sbb('2026-08-19', 'Zug – Bern und zurück', 58.00) },
      { file: 'IMG_7731.jpg', day: '2026-08-24', what: 'Buchhandlung am Postplatz, a book (2.6 %)', amount: 54.00, code: 'I26', account: '6500', photo: tillPhoto({ shop: 'Buchhandlung am Postplatz', uid: `${uidOf(['8812', '0457'].join(''))} MWST`, lines: [['Buch: Prozesse digitalisieren', 54.00]], total: 54.00, vat: [[2.6, r2((54 * 2.6) / 102.6)]], paid: 'Mastercard ****1150', date: '2026-08-24', time: '17:18', tilt: -2.5 }) },
    ],
    '09': [
      { file: 'SBB_Billett_Zug-Zuerich.pdf', day: '2026-09-09', what: 'SBB Zug–Zürich HB retour', amount: 53.60, code: 'I81', account: '6640', html: sbb('2026-09-09', 'Zug – Zürich HB und zurück', 53.60) },
      { file: 'IMG_7748.jpg', day: '2026-09-16', what: 'Parkhaus Metalli, parking at a client', amount: 18.00, code: 'I81', account: '6200 or 6640', photo: tillPhoto({ shop: 'Parkhaus Metalli Zug', uid: `${uidOf(['9035', '6621'].join(''))} MWST`, lines: [['Parkieren 09:12–14:48', 18.00]], total: 18.00, vat: [[8.1, r2((18 * 8.1) / 108.1)]], paid: 'Mastercard ****1150', date: '2026-09-16', time: '14:49', tilt: 2, bg: '#55524a' }) },
    ],
  };
  const photos = {};
  for (const [m, list] of Object.entries(outlays)) {
    for (const o of list) { if (o.html) docs[o.file] = o.html; else photos[o.file] = o.photo; entries.push([o.day, o.code, o.amount, o.what]); }
    const total = sum(list, (o) => o.amount);
    add(zkb, m === '09' ? '2026-09-30' : bankDay(`2026-${m}-${m === '07' ? '31' : '31'}`), 'DBIT', total, FIRM.owner, `Spesen ${MONTH[m]} 2026`, 'PMNT/ICDT/DMCT', `2451 / 1020, no VAT code: the reimbursement of ${list.map((o) => `${o.what} (${o.file}, ${o.account} / 2451 ${o.code})`).join(' and ')}`);
  }

  // ─── The rest ────────────────────────────────────────────────────────────────
  add(zkb, '2026-08-27', 'DBIT', 3912.45, 'Eidg. Steuerverwaltung ESTV', 'MWST 2. Quartal 2026', 'PMNT/ICDT/DMCT', '2201 (or 2200) / 1020, no VAT code: the Q2 return paid');
  add(zkb, '2026-09-30', 'DBIT', 15.00, 'Zuger Kantonalbank', 'Paketgebühr Q3 2026', 'ACMT/MDOP/FEES', '6940 / 1020, no VAT code, the bank\'s own fee row');

  for (const list of [zkb, wise]) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  zkb.forEach((r, i) => { r.ref = `ZGKB-26-${String(i + 1).padStart(4, '0')}`; });
  // Wise's ids on the entry (AcctSvcrRef): CARD-… for a card payment, TRANSFER-… for money received.
  wise.forEach((r, i) => { r.ref = `${r.dir === 'CRDT' ? 'TRANSFER' : 'CARD'}-${String(9100000 + i * 37)}`; if (r.dir === 'DBIT') r.info = r.text; });
  const OPEN = 38420.60, OPEN_EUR = 1840.00;
  const stZkb = camt({ created: '2026-10-01T05:00:00', stmtId: 'ZGKB-STMT-2026-Q3', iban: IBAN, ccy: 'CHF', owner: FIRM.name, bank: 'Zuger Kantonalbank', open: OPEN, from: '2026-07-01', to: '2026-09-30', rows: zkb });
  const stWise = camt({ created: '2026-10-01T06:00:00', stmtId: 'STM-WISE-2026-Q3', iban: WISE, ccy: 'EUR', owner: FIRM.name, bank: 'Wise Europe SA', open: OPEN_EUR, from: '2026-07-01', to: '2026-09-30', rows: wise });

  // The bank's PDF statement of the same account: the file he finds first in e-banking.
  let bal = OPEN;
  docs['ZugerKB_Kontoauszug_Q3_2026.pdf'] = `<style>${css} td,th{padding:3px;font-size:10px}</style><h1>Zuger Kantonalbank</h1><div class=small>Kontoauszug 01.07.2026 – 30.09.2026<br>${FIRM.name}, ${FIRM.street}, ${FIRM.city}<br>IBAN ${spaced(IBAN)} &nbsp; CHF</div><table><tr><th>Datum</th><th>Text</th><th class=r>Belastung</th><th class=r>Gutschrift</th><th class=r>Saldo</th></tr><tr><td>30.06.2026</td><td>Saldovortrag</td><td></td><td></td><td class=r>${chf(OPEN)}</td></tr>${zkb.map((r) => { bal = r2(bal + (r.dir === 'CRDT' ? r.amount : -r.amount)); return `<tr><td>${dmy(r.date)}</td><td>${r.who}, ${r.text}</td><td class=r>${r.dir === 'DBIT' ? chf(r.amount) : ''}</td><td class=r>${r.dir === 'CRDT' ? chf(r.amount) : ''}</td><td class=r>${chf(bal)}</td></tr>`; }).join('')}<tr><th colspan=4>Schlusssaldo 30.09.2026</th><th class=r>${chf(stZkb.close)}</th></tr></table>`;
  // A photo of the whiteboard after a workshop: no receipt.
  photos['IMG_7702.jpg'] = `<body style="margin:0;background:#d9d6cf;height:900px;padding:40px;box-sizing:border-box"><div style="background:#fbfbf8;border:12px solid #9aa0a6;height:760px;transform:rotate(-1.5deg);font:28px 'Marker Felt',Comic Sans MS,cursive;color:#1f4fa3;padding:30px">Workshop Stiftungsrat<br><br>1. Ist-Prozesse ✓<br>2. Pain points → Digitalisierung<br>3. Roadmap 2027<br><br><span style="color:#b33">!! Budget klären</span></div></body>`;

  // ─── The fiduciary's balance sheets: the year's opening per 31.12.2025 and the interim balance per 30.06.2026 ───
  const fid = 'Treuhand Zugersee AG, Zug';
  const wise31 = r2(1200 * rate('EUR', '2025-12-31')), wise30 = r2(OPEN_EUR * rate('EUR', '2026-06-30'));
  const dec = { bank: 29118.40, it: 2400, vat: 3104.80, owner: 1250.00, capital: 20000 };
  dec.carried = r2(dec.bank + wise31 + dec.it - dec.vat - dec.owner - dec.capital);
  const jun = { vat: 3912.45 };
  jun.profit = r2(OPEN + wise30 + dec.it - jun.vat - dec.capital - dec.carried);
  const opening = {
    dec: [['1020', 'Zuger Kantonalbank', dec.bank], ['1021', `Wise EUR (EUR 1'200.00)`, wise31], ['1520', 'Informatik', dec.it]],
    decL: [['2201', 'Abrechnungskonto MWST (4. Quartal 2025)', dec.vat], ['2451', `Kontokorrent ${FIRM.owner}`, dec.owner], ['2800', 'Stammkapital', dec.capital], ['2970', 'Gewinnvortrag', dec.carried]],
    jun: [['1020', 'Zuger Kantonalbank', OPEN], ['1021', `Wise EUR (EUR ${chf(OPEN_EUR)})`, wise30], ['1520', 'Informatik', dec.it]],
    junL: [['2201', 'Abrechnungskonto MWST (2. Quartal 2026)', jun.vat], ['2800', 'Stammkapital', dec.capital], ['2970', 'Gewinnvortrag', dec.carried], ['', 'Gewinn 1.1.–30.6.2026', jun.profit]],
  };
  docs['Bilanz_31.12.2025_Treuhand.pdf'] = balanceSheet({ firm: FIRM, fiduciary: fid, title: 'Bilanz', date: '2025-12-31', assets: opening.dec, liabilities: opening.decL });
  docs['Zwischenbilanz_30.06.2026_Treuhand.pdf'] = balanceSheet({ firm: FIRM, fiduciary: fid, title: 'Zwischenbilanz', date: '2026-06-30', assets: opening.jun, liabilities: opening.junL });

  const files = { [CAMT]: stZkb.xml, [CAMT_WISE]: stWise.xml };
  const copies = [['Cloudhaven_Invoice_2026-07 (1).pdf', 'Cloudhaven_Invoice_2026-07.pdf']];

  // ─── The answer key ───────────────────────────────────────────────────────
  const z = vatBoxes(entries);
  const phoneTax = (share) => sum(['07', '08', '09'], (m) => r2((r2(phones[m] * share) * 8.1) / 108.1));
  const k = chf;
  const rowsOf = (list, acct) => list.map((r) => [dmy(r.date), acct, r.who, `${r.dir === 'CRDT' ? '+' : '-'}${k(r.amount)}`, r.should]);
  const key = [
    `# Answer key: ${FIRM.name}, Q3 2026`,
    '',
    `Generated by \`node .claude/skills/verify/persona-files.mjs --key consulting\`. Firm ${FIRM.name}, UID ${UID}, owner ${FIRM.owner} (its only employee), effective method, cash basis, quarterly. Accounts: Zuger Kantonalbank CHF ${spaced(IBAN)} (1020), Wise EUR ${spaced(WISE)} (1021).`,
    '',
    '## The VAT of Q3 (Ziffern, as the books should declare them)',
    '',
    table(['Ziffer', 'CHF'], Object.entries(z).map(([b, v]) => [b, k(v)])),
    '',
    `- The phone is in these figures whole at I81, its private share corrected at the year close (the setup's «private use: phone»). With the wish «Telefon zur Hälfte privat» as \`private: 50\`, 405 and 479 are CHF ${k(phoneTax(0.5))} lower and 500 that much higher; as \`private: { share: 50, as: own-use }\`, 405 stays and 415 is CHF ${k(phoneTax(0.5))} (the same tax owed).`,
    `- The credit card settlement (CHF ${k(card.total)} on ${dmy(card.day)}) is in these figures split by its statement's lines, the hotel's bill linked to its line: see «The credit card» below for the other acceptable states and their figures.`,
    `- 221 is the Nordwerk payment, EUR ${n(nw.total)} at the ESTV rate of ${dmy(nwDay)} (${rate('EUR', nwDay)}). The September retainer ${inv('RE-2026-036').no} (CHF ${k(inv('RE-2026-036').total)}) is unpaid on 30.09.: on the cash basis no Q3 turnover. The June retainer ${june.no} paid on 03.07. is.`,
    `- No input tax without a receipt that shows Swiss VAT: the salary, AHV, BVG, ESTV and the bank fee have none (a zero input code such as I0 on them is a low finding, no figure); Cloudhaven, Notably, Promptly and Linkly show no Swiss VAT (Bezugsteuer), Planwise does (I81, a German vendor with a CHE number).`,
    '',
    '## Wages and contributions',
    '',
    ...pay.keyLines,
    '',
    '## The credit card',
    '',
    `The bank shows one settlement of CHF ${k(card.total)} (${dmy(card.day)}); its lines stand only on \`Alpencard_Abrechnung_August_2026.pdf\`. A correct outcome, whether the app reads that statement as a receipt of the settlement and splits it, or the owner books the lines by hand:`,
    '',
    `- each line with its own account and code: Linkly Ads CHF ${k(linkly.chf)} B81-1 (Bezugsteuer: its own invoice, \`Linkly_Ads_Invoice_2026-08.pdf\`, shows no Swiss VAT), the card's foreign-currency fee CHF ${k(linkly.fx)} without a code (6940), the hotel CHF ${k(hotel.total)} on 6640;`,
    `- the hotel's 3.8 % (CHF ${k(r2((158 * 3.8) / 103.8))}, I38 on 158.00; the Kurtaxe 6.00 without VAT) claimed only when the hotel's own bill (\`Hotel_Pilatusblick_Rechnung.pdf\`) is linked to that line: the card statement is no invoice. Without the bill linked, the hotel line without input tax is right, and 405 is CHF ${k(r2((158 * 3.8) / 103.8))} lower;`,
    `- the settlement booked whole on one account with no split: wrong for 383 (Linkly's CHF ${k(linkly.chf)} missing) unless it is a stated, temporary state;`,
    `- what the app should say: what it did with the card statement (read as the settlement's receipt and split, or not imported: docs/getting-started.md, Limits, issue #94), never that it imported the card's transactions as an account, and which line still needs its own receipt.`,
    '',
    '## Opening balances',
    '',
    `The fiduciary kept the first half year; the files hold its balance sheet per 31.12.2025 (\`Bilanz_31.12.2025_Treuhand.pdf\`) and its interim balance per 30.06.2026 (\`Zwischenbilanz_30.06.2026_Treuhand.pdf\`). The app takes an opening per 1 January under Firma › Eröffnung; books that begin mid-year are an open question (issue #358). Acceptable:`,
    '',
    `- the opening per 1.1.2026 from the 31.12.2025 balance sheet: ${opening.dec.concat(opening.decL).map(([a, nm, v]) => `${a} ${nm} CHF ${k(v)}`).join(', ')}. The bank accounts then differ from the statements' opening on 01.07. by the first half year's movements (1020: CHF ${k(r2(OPEN - dec.bank))}; 1021: EUR ${k(r2(OPEN_EUR - 1200))}), which the app should state as a fact, not as an error in the statement;`,
    `- the balances per 30.06.2026, if the app offers a start mid-year: ${opening.jun.concat(opening.junL).map(([a, nm, v]) => `${a || '–'} ${nm} CHF ${k(v)}`).join(', ')}. 2201 then holds the Q2 VAT the ESTV payment of 27.08. settles.`,
    '',
    'A walk in mid-November opens the app in Q4 until the first drop: the files are Q3. Finding the period of the files is checkpoint 11.',
    '',
    `## The ${zkb.length + wise.length} payments of the two statements`,
    '',
    table(['day', 'account', 'who', 'amount', 'should become'], [...rowsOf(zkb, 'ZKB CHF'), ...rowsOf(wise, 'Wise EUR')]),
    '',
    `Zuger Kantonalbank: opening CHF ${k(OPEN)} on 01.07., closing CHF ${k(stZkb.close)} on 30.09.; Wise EUR: opening EUR ${k(OPEN_EUR)}, closing EUR ${k(stWise.close)}. Every entry of both statements carries its own reference on the entry (ZGKB-…, CARD-…, TRANSFER-…).`,
    'Accounts the key names where two are sensible: parking on 6200 or 6640; a book on 6500 or 5810. Codes are what the figures check.',
    '',
    '## The files',
    '',
    `- His own invoices (${invoices.length} PDFs, ${invoices.map((i) => i.no).join(', ')}): sales records the payments are matched with; RE-2026-036 stays open. The June invoice ${june.no} is not among them.`,
    '- `ZugerKB_Kontoauszug_Q3_2026.pdf`: the bank\'s PDF statement of the same account as the camt.053. Dropped with or before the camt it must not bring the payments in twice.',
    `- \`Alpencard_Abrechnung_August_2026.pdf\`: the company credit card's statement (see «The credit card»).`,
    `- Payslips (\`Lohnabrechnung_2026-07…09_Kaelin.pdf\`), the Akonto bill and the pension fund's bill: see «Wages and contributions». The balance sheets: see «Opening balances».`,
    '- `IMG_7702.jpg`: a whiteboard photo, no receipt. `Cloudhaven_Invoice_2026-07 (1).pdf`: a duplicate.',
  ].join('\n');
  const summary = [
    `- ${zkb.length} payments on the CHF statement and ${wise.length} on the Wise EUR statement; ${invoices.length} own invoices (one to Germany in EUR, one still open), ${Object.values(outlays).flat().length} receipts paid privately and reimbursed in three monthly payments, one credit card settlement, three payslips, the fiduciary's balance sheets per 31.12.2025 and 30.06.2026.`,
    `- Ziffer 200 about CHF ${chf(Math.round(z['200'])).slice(0, -3)}, tax payable (500) about CHF ${chf(Math.round(z['500'] ?? -z['510'])).slice(0, -3)}; Ziffern in whole francs: ${Object.entries(z).map(([b, v]) => `${b} ${chf(Math.round(v)).slice(0, -3)}`).join(', ')}; the exact figures, the variants of the phone's private share and the card, and every payment: \`answer-key.md\`.`,
  ].join('\n');

  return {
    files, docs, photos, copies, key, summary, entries,
    env: `PERSONA=consulting\nPERSONA_IBAN=${IBAN}\nPERSONA_IBAN_SPACED='${spaced(IBAN)}'\nPERSONA_UID=${UID}\nPERSONA_CAMT=${CAMT}\nPERSONA_CAMT_WISE=${CAMT_WISE}\nPERSONA_WISE_IBAN=${WISE}\n`,
  };
}
