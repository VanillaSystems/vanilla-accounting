// Made-up files of a webshop (Teegarten Wyss GmbH, Sursee LU) on Shopify for persona tests: tea at
// 2.6 %, teaware at 8.1 %, a few orders abroad. The sales arrive as Shopify Payments payouts (paid by
// Stripe, «SHOPIFY …» in the reference), several a week, each the charges of some days less their
// fees and refunds. Everything is simulated from one list of orders, so the statement, Shopify's three
// exports, its monthly bills and the answer key agree to the Rappen. The columns are the ones the app's
// processes/suppliers/shopify.yaml names (orders export, payments transactions export); the payouts
// export is the file she finds first and is no report the app reads.
import { ibanOf, uidOf, spaced, n, r2, r05, chf, mulberry32, addDays, weekday, bankDay, days, dmy, camt, csv, table, css, tillPhoto, estvRates, vatBoxes, payroll, balanceSheet } from './kit.mjs';

const REPO = new URL('../../../../', import.meta.url).pathname;
const Q3 = { from: '2026-07-01', to: '2026-09-30' };
const inQ3 = (d) => d >= Q3.from && d <= Q3.to;
const sum = (xs, f = (x) => x) => r2(xs.reduce((s, x) => s + f(x), 0));
const MONTH = { '07': 'Juli', '08': 'August', '09': 'September' };
const MONTH_EN = { '07': 'July', '08': 'August', '09': 'September' };

export default function build() {
  const rnd = mulberry32(20260703);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const rate = estvRates(REPO);

  const FIRM = { name: 'Teegarten Wyss GmbH', street: 'Unterstadt 9', city: '6210 Sursee', owner: 'Corinne Wyss', helper: 'Jana Imhof' };
  const IBAN = ibanOf('00778', ['0047', '1122', '3301'].join(''));
  const UID = uidOf(['6142', '8073'].join(''));
  // The public UIDs of the app's own business files (processes/suppliers/shopify.yaml, swiss-post.yaml): the
  // app knows these businesses by them, so the documents must print them.
  const SHOPIFY_UID = 'CHE-153.004.184';
  const POST_UID = 'CHE-116.302.542';
  const CAMT = 'camt053_LUKB_Q3-2026.xml';
  const to = `${FIRM.name}<br>${FIRM.street}<br>${FIRM.city}`;

  // ─── The orders ────────────────────────────────────────────────────────────
  const WARE = [['Kyusu Tokoname 300 ml', 68.00], ['Teeschale Celadon', 24.00], ['Chasen Matcha-Besen', 29.00], ['Teedose Washi 200 g', 18.50], ['Glaskanne 1 l', 42.00]];
  const TEA = [['Sencha Kagoshima 100 g', 16.50], ['Genmaicha 100 g', 12.00], ['Matcha Uji 30 g', 28.00], ['Darjeeling First Flush 100 g', 19.50], ['Rooibos Vanille 100 g', 9.80]];
  const FIRST = ['Anna', 'Lukas', 'Mia', 'Noah', 'Laura', 'Jonas', 'Sara', 'Elias', 'Lea', 'David', 'Nina', 'Simon', 'Julia', 'Fabian', 'Selina', 'Marco'];
  const LAST = ['Bühler', 'Zurfluh', 'Arnold', 'Bachmann', 'Odermatt', 'Schmid', 'Kaufmann', 'Gisler', 'Achermann', 'Portmann', 'Wicki', 'Felder', 'Bucher', 'Studer'];
  const CITIES = [['6003', 'Luzern'], ['6210', 'Sursee'], ['8004', 'Zürich'], ['3011', 'Bern'], ['4051', 'Basel'], ['6300', 'Zug'], ['9000', 'St. Gallen'], ['7000', 'Chur'], ['1003', 'Lausanne'], ['6900', 'Lugano']];
  const ABROAD = { DE: [['80331', 'München'], ['79098', 'Freiburg']], AT: [['6020', 'Innsbruck'], ['1070', 'Wien']], FR: [['68100', 'Mulhouse']], NL: [['3511', 'Utrecht']] };
  const stamp = (d) => `${d} ${String(7 + Math.floor(rnd() * 15)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')} +0200`;

  /** An order: lines [{ name, price, qty, rate }]; domestic prices include Swiss VAT, abroad the price without it. */
  const order = (o) => {
    const domestic = o.country === 'CH' || o.country === 'LI';
    const lines = o.items.map(([name, price, qty, vat]) => ({ name, qty, price: domestic ? price : r05(price / (1 + vat / 100)), rate: vat }));
    const subtotal = sum(lines, (l) => l.price * l.qty);
    const shipping = domestic ? (subtotal >= 80 ? 0 : 7) : 18;
    // Shipping takes the rate of the goods it carries; an order of one rate has one tax line.
    const taxes = {};
    if (domestic) {
      for (const l of lines) taxes[l.rate] = (taxes[l.rate] ?? 0) + l.price * l.qty;
      const only = Object.keys(taxes);
      if (shipping) taxes[only[0]] += shipping;
      for (const k of only) taxes[k] = { base: r2(taxes[k]), tax: r2((taxes[k] * Number(k)) / (100 + Number(k))) };
    }
    const first = pick(FIRST), last = pick(LAST);
    const [zip, city] = o.city ?? (domestic ? (o.country === 'LI' ? ['9490', 'Vaduz'] : pick(CITIES)) : pick(ABROAD[o.country]));
    return {
      created: o.created, paid: o.paid ?? o.created, gateway: o.gateway ?? 'Shopify Payments', country: o.country, lines, subtotal, shipping,
      taxes, tax: sum(Object.values(taxes), (t) => t.tax), gross: r2(subtotal + shipping), name: `${first} ${last}`,
      email: `${first}.${last}`.toLowerCase().replace(/ü/g, 'ue') + (domestic ? '@example.ch' : '@example.de'), zip, city,
      refund: o.refund, kind: o.kind ?? 'plain',
    };
  };
  const basket = (kind) => {
    const list = kind === 'ware' ? WARE : TEA;
    const k = rnd() < 0.45 ? 1 : rnd() < 0.7 ? 2 : 3;
    const chosen = [...list].sort(() => rnd() - 0.5).slice(0, k);
    return chosen.map(([name, price]) => [name, price, 1 + Math.floor(rnd() * (kind === 'ware' ? 2 : 4)), kind === 'ware' ? 8.1 : 2.6]);
  };
  const orders = [];
  for (const d of days('2026-06-15', Q3.to)) {
    const k = [0, 6].includes(weekday(d)) ? pick([1, 2, 2, 3]) : pick([2, 3, 3, 4, 5]);
    for (let i = 0; i < k; i++) {
      const country = rnd() < 0.9 ? 'CH' : pick(['DE', 'DE', 'AT', 'FR', 'NL']);
      orders.push(order({ created: stamp(d), country, items: basket(rnd() < 0.45 ? 'ware' : 'tea') }));
    }
  }
  // The orders a real first quarter has besides: each one a check of its own.
  const special = {
    // A teacup arrived broken: CHF 24 back through Shopify on its own day (the payments export dates it).
    refund: order({ created: '2026-07-20 19:12:44 +0200', country: 'CH', items: [['Kyusu Tokoname 300 ml', 68.00, 1, 8.1], ['Teeschale Celadon', 24.00, 2, 8.1]], refund: { day: '2026-08-03', at: '2026-08-03 10:14:02 +0200', amount: 24.00 }, kind: 'refund' }),
    // A customer in Liechtenstein: inside the Swiss VAT territory, so 8.1 %, not an export.
    li: order({ created: '2026-07-22 08:41:10 +0200', country: 'LI', items: [['Glaskanne 1 l', 42.00, 1, 8.1], ['Teeschale Celadon', 24.00, 1, 8.1]], kind: 'li' }),
    // Tea and a teapot in one cart: two rates in one order, which the app cannot read off one tax column.
    mixed: order({ created: '2026-08-12 21:03:57 +0200', country: 'CH', items: [['Kyusu Tokoname 300 ml', 68.00, 1, 8.1], ['Sencha Kagoshima 100 g', 16.50, 2, 2.6]], kind: 'mixed' }),
    // Her own test order of the checkout, through Shopify's test gateway: no sale.
    test: order({ created: '2026-07-02 07:58:21 +0200', country: 'CH', gateway: 'bogus', items: [['Rooibos Vanille 100 g', 9.80, 1, 2.6]], kind: 'test' }),
    // Paid by bank transfer (Vorkasse): the money comes to the bank account, not through Shopify.
    deposit1: order({ created: '2026-07-17 16:20:05 +0200', paid: '2026-07-20 09:00:00 +0200', country: 'CH', gateway: 'Bank Deposit', items: [['Kyusu Tokoname 300 ml', 68.00, 2, 8.1], ['Chasen Matcha-Besen', 29.00, 1, 8.1]], kind: 'deposit' }),
    // Paid by bank transfer, sent back, refunded by bank transfer.
    deposit2: order({ created: '2026-08-24 11:47:33 +0200', paid: '2026-08-27 09:00:00 +0200', country: 'CH', gateway: 'Bank Deposit', items: [['Glaskanne 1 l', 42.00, 2, 8.1]], kind: 'deposit-refunded' }),
  };
  orders.push(...Object.values(special));
  orders.sort((a, b) => (a.created < b.created ? -1 : 1));
  orders.forEach((o, i) => { o.no = `#${1001 + i}`; o.day = o.paid.slice(0, 10); o.createdDay = o.created.slice(0, 10); });
  const sp = (o) => o.gateway === 'Shopify Payments';
  const fee = (o) => r2(o.gross * (o.country === 'CH' || o.country === 'LI' ? 0.029 : 0.034) + 0.30);
  special.deposit2.refundBank = { day: '2026-09-08', amount: special.deposit2.gross };

  // ─── Shopify Payments: charges, refunds, payouts ────────────────────────────
  const tx = [];
  for (const o of orders.filter(sp)) tx.push({ at: o.paid, day: o.day, type: 'charge', order: o.no, amount: o.gross, fee: fee(o), o });
  const rf = special.refund.refund;
  tx.push({ at: rf.at, day: rf.day, type: 'refund', order: special.refund.no, amount: -rf.amount, fee: 0, o: special.refund });
  tx.sort((a, b) => (a.at < b.at ? -1 : 1));
  const payouts = [];
  let pid = 0;
  for (const d of days('2026-06-17', '2026-10-09')) {
    if (![1, 3, 5].includes(weekday(d))) continue;
    // A payout pays the charges up to three days before it and the refunds before its day.
    const due = tx.filter((t) => !t.payout && (t.type === 'charge' ? t.day <= addDays(d, -3) : t.day < d));
    if (!due.length) continue;
    const p = { day: d, id: ['8812', String(4400 + ++pid)].join(''), charges: sum(due.filter((t) => t.type === 'charge'), (t) => t.amount), refunds: sum(due.filter((t) => t.type === 'refund'), (t) => t.amount), fees: sum(due, (t) => t.fee) };
    p.total = r2(p.charges + p.refunds - p.fees);
    for (const t of due) t.payout = p;
    payouts.push(p);
  }
  const net = (t) => r2(t.amount - t.fee);
  const balanceOn = (d) => sum(tx.filter((t) => t.day <= d && !(t.payout && t.payout.day <= d)), net);
  const q3payouts = payouts.filter((p) => inQ3(p.day));

  // ─── The bank statement ────────────────────────────────────────────────────
  const rows = [];
  const add = (date, dir, amount, who, text, code, extra = {}) => rows.push({ date, dir, amount: r2(amount), who, text, code, ...extra });
  for (const p of q3payouts) add(p.day, 'CRDT', p.total, 'Stripe Technology Europe Ltd', `SHOPIFY PAYOUT ${p.id}`, 'PMNT/RCDT/DMCT', { kind: 'payout' });

  // Goods from Japan in USD (no Swiss VAT), the courier's customs bill, the customs office's assessment.
  const kyoto = { no: 'KTW-26-0712', date: '2026-07-06', items: [['Kyusu Tokoname 300 ml, unglazed', 40, 28.00], ['Celadon tea bowl', 60, 9.50], ['Chasen whisk, 80 tines', 10, 15.00]], freight: 120.00 };
  kyoto.usd = r2(sum(kyoto.items, ([, q, p]) => q * p) + kyoto.freight);
  kyoto.chf = r2(kyoto.usd * 0.8265);
  add('2026-07-14', 'DBIT', kyoto.chf, 'KYOTO TEA WARE CO LTD', `INVOICE ${kyoto.no} USD ${n(kyoto.usd)}`, 'PMNT/ICDT/XBCT', { kind: 'kyoto' });
  const customs = { decl: ['26CHWI', '0000', '4711', '8823'].join(''), date: '2026-07-10', value: r2(kyoto.usd * rate('USD', '2026-07-10')) };
  customs.vat = r2(customs.value * 0.081);
  const dhl = { no: ['5310', '7729', '41'].join(''), date: '2026-07-13', fee: 25.00 };
  dhl.feeVat = r2(dhl.fee * 0.081);
  dhl.total = r2(customs.vat + dhl.fee + dhl.feeVat);
  add('2026-07-29', 'DBIT', dhl.total, 'DHL Express (Schweiz) AG', `Rechnung ${dhl.no} Zoll`, 'PMNT/ICDT/DMCT', { kind: 'dhl', iban: ibanOf('00235', ['0235', '1182', '0047'].join('')) });

  // Packaging from a Swiss supplier (8.1 %) and tea from a Swiss wholesaler (2.6 %).
  const kartonage = { no: 'RE-26-4410', date: '2026-07-08', items: [['Versandkarton 30x20x15 cm', 500, 0.62], ['Seidenpapier natur, Pack à 100', 10, 8.90], ['Packband braun 50 mm', 24, 2.35]], rate: 8.1 };
  const teeimport = { no: 'R-88213', date: '2026-08-18', items: [['Sencha Kagoshima lose, kg', 5, 96.00], ['Genmaicha lose, kg', 5, 58.00], ['Rooibos Vanille lose, kg', 10, 26.00], ['Matcha Uji, kg', 1, 310.00]], rate: 2.6 };
  for (const b of [kartonage, teeimport]) { b.net = sum(b.items, ([, q, p]) => q * p); b.vat = r2(b.net * b.rate / 100); b.total = r2(b.net + b.vat); }
  add('2026-08-06', 'DBIT', kartonage.total, 'Kartonage Rigi AG', `Rechnung ${kartonage.no}`, 'PMNT/ICDT/DMCT', { kind: 'kartonage', iban: ibanOf('00780', ['0091', '2233', '4455'].join('')) });
  add('2026-09-02', 'DBIT', teeimport.total, 'Teeimport Basel AG', `Rechnung ${teeimport.no}`, 'PMNT/ICDT/DMCT', { kind: 'teeimport', iban: ibanOf('00770', ['0012', '7788', '0190'].join('')) });

  // Shopify's monthly bill (plan and an app, 8.1 % Swiss VAT), by direct debit.
  const subs = ['07', '08', '09'].map((m, i) => ({ m, no: ['4127', String(3350 + i)].join(''), date: `2026-${m}-12`, net: 45.90 }));
  for (const s of subs) { s.vat = r2(s.net * 0.081); s.total = r2(s.net + s.vat); add(bankDay(addDays(s.date, 1)), 'DBIT', s.total, 'Shopify International Limited', `Shopify Rechnung ${s.no}`, 'PMNT/IDDT/ESDD', { kind: 'subscription' }); }

  // Shopify Payments' monthly invoice of the fees it kept, with the Swiss VAT in them: no payment.
  const feeBills = ['07', '08', '09'].map((m) => {
    const fees = sum(tx.filter((t) => t.day.slice(5, 7) === m && inQ3(t.day)), (t) => t.fee);
    const vat = r2((fees * 8.1) / 108.1);
    return { m, fees, vat, date: `2026-${m}-${m === '09' ? '30' : '31'}`, no: `SP-2026-${m}` };
  });

  // Swiss Post's monthly bill of the parcel labels: domestic parcels 8.1 %, parcels abroad free of VAT.
  const shipped = (m) => orders.filter((o) => o.kind !== 'test' && o.createdDay.slice(5, 7) === m && o.createdDay >= Q3.from);
  const post = ['07', '08'].map((m, i) => {
    const dom = shipped(m).filter((o) => o.country === 'CH' || o.country === 'LI').length, abroad = shipped(m).filter((o) => !(o.country === 'CH' || o.country === 'LI')).length;
    const b = { m, no: ['7740', String(1180 + i)].join(''), date: i ? '2026-09-02' : '2026-08-03', dom, abroad, domNet: r2(dom * 9.00), abroadNet: r2(abroad * 24.00) };
    b.vat = r2(b.domNet * 0.081); b.total = r2(b.domNet + b.abroadNet + b.vat); b.paid = bankDay(addDays(b.date, 21));
    add(b.paid, 'DBIT', b.total, 'Post CH AG', `Rechnung ${b.no}`, 'PMNT/ICDT/DMCT', { kind: 'post', iban: ibanOf('09000', ['0000', '3001', '8402'].join('')) });
    return b;
  });

  // Packaging material at the farm store, by debit card: the till receipt is a phone photo.
  const landi = { lines: [['Luftpolsterfolie 50 m', 24.95], ['Klebeband 6 Stk', 13.80], ['Paketschnur', 7.95]] };
  landi.total = sum(landi.lines, (l) => l[1]); landi.vat = r2((landi.total * 8.1) / 108.1);
  add('2026-08-21', 'DBIT', landi.total, 'LANDI Sursee', 'Debitkarte 4471 Einkauf LANDI Sursee', 'PMNT/CCRD/POSD', { kind: 'landi' });

  // Two orders paid by bank transfer, one of them sent back and refunded from the bank.
  const d1 = special.deposit1, d2 = special.deposit2;
  add(d1.day, 'CRDT', d1.gross, d1.name, `Bestellung ${d1.no} Teegarten`, 'PMNT/RCDT/DMCT', { kind: 'deposit', o: d1 });
  add(d2.day, 'CRDT', d2.gross, d2.name, `Bestellung ${d2.no}`, 'PMNT/RCDT/DMCT', { kind: 'deposit', o: d2 });
  add(d2.refundBank.day, 'DBIT', d2.refundBank.amount, d2.name, `Rückerstattung Bestellung ${d2.no}`, 'PMNT/ICDT/DMCT', { kind: 'deposit-refund', o: d2 });

  // Wages and contributions as the payroll's documents state them (kit.mjs payroll): payslips, the Akonto bill, the pension fund's bill.
  const pay = payroll({
    firm: { name: FIRM.name, street: FIRM.street, city: FIRM.city }, months: ['07', '08', '09'],
    people: [{ name: FIRM.owner, role: 'Geschäftsführerin', gross: 4700, bvg: 199.20 }, { name: FIRM.helper, role: 'Mitarbeiterin Versand (40 %)', gross: 1550 }],
    ahvFund: { name: 'Ausgleichskasse Luzern', addr: 'Würzenbachstrasse 8, 6006 Luzern', no: 'AK-26-Q3-30871', file: 'Ausgleichskasse_Luzern' },
    bvgFund: { name: 'Pensionskasse Zentral', addr: 'Bundesplatz 14, 6003 Luzern', no: 'PK-26-3-1180', file: 'Pensionskasse' },
    ahvDate: '2026-07-07', bvgDate: '2026-07-01',
  });
  for (const m of ['07', '08', '09']) for (const p of pay.people) add(bankDay(`2026-${m}-25`), 'DBIT', p.net, p.name, `Lohn ${MONTH[m]} 2026`, 'PMNT/ICDT/SALA', { kind: 'wage' });
  add('2026-09-28', 'DBIT', pay.ahv.total, 'Ausgleichskasse Luzern', 'Akonto AHV/IV/EO/ALV Q3 2026 AK-26-Q3-30871', 'PMNT/ICDT/DMCT', { kind: 'ahv' });
  add('2026-07-10', 'DBIT', pay.bvg.total, 'Pensionskasse Zentral', 'Beiträge Q3 2026 PK-26-3-1180', 'PMNT/ICDT/DMCT', { kind: 'bvg' });
  add('2026-08-26', 'DBIT', 2208.35, 'Eidg. Steuerverwaltung ESTV', 'MWST 2. Quartal 2026', 'PMNT/ICDT/DMCT', { kind: 'estv' });
  add('2026-09-30', 'DBIT', 9.00, 'Luzerner Kantonalbank', 'Kontoführung Q3', 'ACMT/MDOP/FEES', { kind: 'fee' });

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  rows.forEach((r, i) => { r.ref = `LUKB-26-${String(i + 1).padStart(4, '0')}`; });
  const OPEN = 21460.25;
  const statement = camt({ created: '2026-10-01T05:30:00', stmtId: 'LUKB-STMT-2026-Q3', iban: IBAN, ccy: 'CHF', owner: FIRM.name, bank: 'Luzerner Kantonalbank', open: OPEN, from: '2026-07-01', to: Q3.to, rows });

  // ─── Shopify's exports ─────────────────────────────────────────────────────
  const q3orders = orders.filter((o) => inQ3(o.createdDay));
  const ORDER_HEAD = ['Name', 'Email', 'Financial Status', 'Paid at', 'Fulfillment Status', 'Fulfilled at', 'Currency', 'Subtotal', 'Shipping', 'Taxes', 'Total', 'Discount Code', 'Discount Amount', 'Shipping Method', 'Created at', 'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem sku', 'Lineitem taxable', 'Billing Name', 'Billing City', 'Billing Zip', 'Billing Country', 'Shipping Name', 'Shipping City', 'Shipping Zip', 'Shipping Country', 'Cancelled at', 'Payment Method', 'Refunded Amount', 'Outstanding Balance', 'Id', 'Tax 1 Name', 'Tax 1 Value', 'Tax 2 Name', 'Tax 2 Value', 'Source'];
  const orderRows = [];
  for (const o of q3orders) {
    const refunded = o.refund?.amount ?? o.refundBank?.amount ?? 0;
    const status = refunded >= o.gross ? 'refunded' : refunded ? 'partially_refunded' : 'paid';
    const taxLines = Object.entries(o.taxes).sort((a, b) => Number(b[0]) - Number(a[0]));
    o.lines.forEach((l, i) => {
      const head = i === 0;
      orderRows.push([
        o.no, o.email, head ? status : '', head ? o.paid : '', head ? 'fulfilled' : '', head ? addDays(o.createdDay, 1) + ' 10:30:00 +0200' : '', head ? 'CHF' : '',
        head ? n(o.subtotal) : '', head ? n(o.shipping) : '', head ? n(o.tax) : '', head ? n(o.gross) : '', '', head ? '0.00' : '',
        head ? (o.country === 'CH' || o.country === 'LI' ? 'PostPac Priority' : 'PostPac International') : '', o.created, l.qty, l.name, n(l.price), '', 'true',
        head ? o.name : '', head ? o.city : '', head ? o.zip : '', head ? o.country : '', head ? o.name : '', head ? o.city : '', head ? o.zip : '', head ? o.country : '',
        '', head ? o.gateway : '', head ? n(refunded) : '', head ? '0.00' : '', head ? String(5800000 + Number(o.no.slice(1))) : '',
        head && taxLines[0] ? `CH MWST ${taxLines[0][0]}%` : '', head && taxLines[0] ? n(taxLines[0][1].tax) : '', head && taxLines[1] ? `CH MWST ${taxLines[1][0]}%` : '', head && taxLines[1] ? n(taxLines[1][1].tax) : '', head ? 'web' : '',
      ]);
    });
  }
  const q3tx = tx.filter((t) => inQ3(t.day));
  const TX_HEAD = ['Transaction Date', 'Type', 'Order', 'Card Brand', 'Card Source', 'Payout Status', 'Payout Date', 'Payout ID', 'Available On', 'Amount', 'Fee', 'Net', 'Checkout', 'Payment Method Name', 'Presentment Amount', 'Presentment Currency', 'Currency'];
  const txRows = q3tx.map((t, i) => [t.at, t.type, t.order, pick(['visa', 'master', 'twint', 'visa']), 'online', t.payout && t.payout.day <= Q3.to ? 'paid' : 'pending', t.payout?.day ?? '', t.payout?.id ?? '', addDays(t.day, 3), n(t.amount), n(t.fee), n(net(t)), String(31000 + i), 'card', n(t.amount), 'CHF', 'CHF']);
  const PAYOUT_HEAD = ['Payout Date', 'Status', 'Charges', 'Refunds', 'Adjustments', 'Reserved Funds', 'Fees', 'Retried Amount', 'Total', 'Currency'];
  const payoutRows = q3payouts.map((p) => [p.day, 'paid', n(p.charges), n(p.refunds), '0.00', '0.00', n(-p.fees), '0.00', n(p.total), 'CHF']);

  // ─── Documents ─────────────────────────────────────────────────────────────
  const swissInvoice = (vendor, addr, uid, b, iban) => `<style>${css}</style><h1>${vendor}</h1><div class=small>${addr}<br>MWST-Nr. ${uid} MWST</div><p style="margin-top:30px">${to}</p>
  <h2>Rechnung ${b.no}</h2><p>Datum: ${dmy(b.date)}</p><table><tr><th>Artikel</th><th class=r>Menge</th><th class=r>Preis</th><th class=r>Betrag CHF</th></tr>${b.items.map(([t, q, p]) => `<tr><td>${t}</td><td class=r>${q}</td><td class=r>${n(p)}</td><td class=r>${n(q * p)}</td></tr>`).join('')}
  <tr><td colspan=3>Total exkl. MWST</td><td class=r>${n(b.net)}</td></tr><tr><td colspan=3>MWST ${b.rate}%</td><td class=r>${n(b.vat)}</td></tr><tr><th colspan=3>Total CHF</th><th class=r>${n(b.total)}</th></tr></table><p>Zahlbar innert 30 Tagen. IBAN ${spaced(iban)}</p>`;
  const docs = {};
  docs[`Invoice_${kyoto.no}.pdf`] = `<style>${css}</style><h1>Kyoto Tea Ware Co., Ltd.</h1><div class=small>3-14 Gojo-zaka, Higashiyama-ku, Kyoto 605-0846, Japan</div><p style="margin-top:30px">${to}<br>Switzerland</p><h2>Commercial Invoice ${kyoto.no}</h2><p>Date: ${dmy(kyoto.date)} &nbsp; Terms: prepayment, DAP Sursee, shipped by DHL Express</p><table><tr><th>Item</th><th class=r>Qty</th><th class=r>Unit USD</th><th class=r>Amount USD</th></tr>${kyoto.items.map(([t, q, p]) => `<tr><td>${t}</td><td class=r>${q}</td><td class=r>${n(p)}</td><td class=r>${n(q * p)}</td></tr>`).join('')}<tr><td colspan=3>Freight DHL Express to Switzerland</td><td class=r>${n(kyoto.freight)}</td></tr><tr><th colspan=3>Total USD</th><th class=r>${n(kyoto.usd)}</th></tr></table><p class=small>Export from Japan. Import duties and taxes of the country of destination are borne by the buyer.</p>`;
  docs[`DHL_Zollrechnung_${dhl.no}.pdf`] = `<style>${css}</style><h1>DHL Express (Schweiz) AG</h1><div class=small>Peter Merian-Strasse 88, 4052 Basel</div><p style="margin-top:30px">${to}</p><h2>Rechnung Zoll und Steuern ${dhl.no}</h2><p>Datum: ${dmy(dhl.date)} &nbsp; Sendung aus Japan, Absender Kyoto Tea Ware Co., Ltd.<br>Zollanmeldung Nr. ${customs.decl}, Zugangscode: K7Q2M9XA (Veranlagungsverfügung unter e-dec-web.ezv.admin.ch)</p><table><tr><th>Position</th><th>MWST-Code</th><th class=r>Betrag CHF</th></tr><tr><td>Zoll</td><td>Z 0%</td><td class=r>0.00</td></tr><tr><td>Einfuhrsteuer</td><td>Z 0%</td><td class=r>${n(customs.vat)}</td></tr><tr><td>Vorlageprovision</td><td>E 8.1%</td><td class=r>${n(dhl.fee)}</td></tr><tr><td>MWST 8.1% auf ${n(dhl.fee)}</td><td>E</td><td class=r>${n(dhl.feeVat)}</td></tr><tr><th colspan=2>Total CHF</th><th class=r>${n(dhl.total)}</th></tr></table><p>Zahlbar innert 30 Tagen. MWST-Nr. CHE-116.304.564 MWST</p>`;
  docs[`Veranlagungsverfuegung_${customs.decl}.pdf`] = `<style>${css}</style><h1>Veranlagungsverfügung MWST</h1><div class=small>Bundesamt für Zoll und Grenzsicherheit BAZG</div><table><tr><td>Zollanmeldung</td><td>${customs.decl}</td></tr><tr><td>Datum der Annahme</td><td>${dmy(customs.date)}</td></tr><tr><td>Importeur</td><td>${FIRM.name}, ${FIRM.street}, ${FIRM.city}</td></tr><tr><td>UID Importeur</td><td>${UID}</td></tr><tr><td>Spediteur</td><td>DHL Express (Schweiz) AG</td></tr><tr><td>Ursprungsland</td><td>JP</td></tr></table><table><tr><th>Warenbezeichnung</th><th class=r>Steuerwert CHF</th><th class=r>MWST-Satz</th><th class=r>MWST CHF</th></tr><tr><td>Keramik- und Bambuswaren, Teegeschirr</td><td class=r>${n(customs.value)}</td><td class=r>8.1%</td><td class=r>${n(customs.vat)}</td></tr></table><p><b>Gesamtbetrag MWST CHF ${n(customs.vat)}</b></p>`;
  docs[`Kartonage_Rigi_${kartonage.no}.pdf`] = swissInvoice('Kartonage Rigi AG', 'Grepperstrasse 21, 6403 Küssnacht', uidOf(['3307', '2914'].join('')), kartonage, ibanOf('00780', ['0091', '2233', '4455'].join('')));
  docs[`Teeimport_Basel_${teeimport.no}.pdf`] = swissInvoice('Teeimport Basel AG', 'Dreispitzstrasse 5, 4053 Basel', uidOf(['4471', '0688'].join('')), teeimport, ibanOf('00770', ['0012', '7788', '0190'].join('')));
  for (const s of subs) docs[`Shopify_Rechnung_${MONTH[s.m]}_2026.pdf`] = `<style>${css}</style><h1>Shopify</h1><div class=small>Shopify International Limited, 2nd Floor, 1-2 Victoria Buildings, Haddington Road, Dublin 4, Irland<br>MWST-Nr. ${SHOPIFY_UID} MWST</div><p style="margin-top:30px">${to}</p><h2>Rechnung ${s.no}</h2><p>Rechnungsdatum: ${dmy(s.date)} &nbsp; Abrechnungszeitraum: ${MONTH[s.m]} 2026</p><table><tr><td>Basic-Abo</td><td class=r>36.00</td></tr><tr><td>App: Versandetiketten Pro</td><td class=r>9.90</td></tr><tr><td>Zwischensumme</td><td class=r>${n(s.net)}</td></tr><tr><td>MWST 8.1%</td><td class=r>${n(s.vat)}</td></tr><tr><th>Total CHF</th><th class=r>${n(s.total)}</th></tr></table><p>Wird per Lastschrift von Ihrem Konto belastet.</p>`;
  for (const f of feeBills) docs[`Shopify_Payments_Invoice_2026-${f.m}.pdf`] = `<style>${css}</style><h1>Shopify Payments Invoice for ${MONTH_EN[f.m]} 2026</h1><div class=small>Shopify International Limited, 2nd Floor, 1-2 Victoria Buildings, Haddington Road, Dublin 4, Ireland<br>VAT number ${SHOPIFY_UID} MWST</div><p style="margin-top:30px">${to}</p><p>Invoice ${f.no} &nbsp; Invoice date: ${dmy(f.date)}</p><table><tr><td>Transaction fees Shopify Payments, ${MONTH_EN[f.m]} 2026 (excl. VAT)</td><td class=r>${n(r2(f.fees - f.vat))}</td></tr><tr><td>VAT 8.1%</td><td class=r>${n(f.vat)}</td></tr><tr><th>Total CHF</th><th class=r>${n(f.fees)}</th></tr></table><p>No payment is due: these fees were deducted from your payouts.</p>`;
  for (const b of post) docs[`PostCH_Rechnung_${b.no}.pdf`] = `<style>${css}</style><h1>Post CH AG</h1><div class=small>Wankdorfallee 4, 3030 Bern<br>MWST-Nr. ${POST_UID} MWST</div><p style="margin-top:30px">${to}</p><h2>Rechnung ${b.no}</h2><p>Datum: ${dmy(b.date)} &nbsp; Leistungszeitraum: ${MONTH[b.m]} 2026, Versandetiketten</p><table><tr><th>Leistung</th><th class=r>Anzahl</th><th class=r>MWST</th><th class=r>Betrag CHF</th></tr><tr><td>PostPac Priority Inland</td><td class=r>${b.dom}</td><td class=r>8.1%</td><td class=r>${n(b.domNet)}</td></tr><tr><td>PostPac International Europa</td><td class=r>${b.abroad}</td><td class=r>0% (Export)</td><td class=r>${n(b.abroadNet)}</td></tr><tr><td colspan=3>Total exkl. MWST</td><td class=r>${n(r2(b.domNet + b.abroadNet))}</td></tr><tr><td colspan=3>MWST 8.1% auf ${n(b.domNet)}</td><td class=r>${n(b.vat)}</td></tr><tr><th colspan=3>Total CHF</th><th class=r>${n(b.total)}</th></tr></table><p>Zahlbar innert 30 Tagen.</p>`;

  const photos = {
    'IMG_2231.jpg': tillPhoto({ shop: 'LANDI Sursee', uid: `${uidOf(['5520', '7711'].join(''))} MWST`, lines: landi.lines, total: landi.total, vat: [[8.1, landi.vat]], paid: 'Debitkarte ****4471', date: '2026-08-21', time: '10:37', tilt: -2 }),
    // A product photo for the shop: no receipt.
    'IMG_2240.jpg': `<body style="margin:0;background:radial-gradient(circle at 50% 45%,#f4efe6,#cfc4b2);height:900px;display:flex;align-items:center;justify-content:center"><div style="width:260px;height:200px;border-radius:50% 50% 45% 45%;background:#7a4a2e;box-shadow:inset -20px -20px 40px #0005, 6px 10px 20px #0004;position:relative"><div style="position:absolute;right:-70px;top:60px;width:90px;height:28px;background:#6b3f27;border-radius:14px;transform:rotate(-20deg)"></div><div style="position:absolute;left:90px;top:-22px;width:80px;height:30px;background:#5d361f;border-radius:40px 40px 6px 6px"></div></div><div style="position:absolute;bottom:60px;font:16px Helvetica;color:#5d4a3a">Kyusu Tokoname – Produktfoto Shop</div></body>`,
  };

  // The credit note she wrote for the order paid by bank transfer and sent back (Shopify › Bestellung › Rückerstattung, printed).
  docs[`Gutschrift_GS-2026-007_${d2.no.slice(1)}.pdf`] = `<style>${css}</style><h1>${FIRM.name}</h1><div class=small>${FIRM.street}, ${FIRM.city}<br>MWST-Nr. ${UID} MWST</div><p style="margin-top:30px">${d2.name}<br>${d2.zip} ${d2.city}</p><h2>Gutschrift GS-2026-007</h2><p>Datum: ${dmy(d2.refundBank.day)} &nbsp; zu Bestellung ${d2.no} vom ${dmy(d2.createdDay)} (Rücksendung)</p><table>${d2.lines.map((l) => `<tr><td>${l.qty} × ${l.name}</td><td class=r>-${n(l.price * l.qty)}</td></tr>`).join('')}<tr><th>Total Gutschrift CHF</th><th class=r>-${n(d2.gross)}</th></tr><tr><td class=small>darin MWST 8.1%</td><td class=r>-${n(r2((d2.gross * 8.1) / 108.1))}</td></tr></table><p>Der Betrag wird auf Ihr Konto überwiesen.</p>`;
  const fid = 'Treuhand Surental GmbH, Sursee';
  const stock = { dec: 7900, jun: 8400 };
  const dec = { bank: 17905.10, shopify: 988.40, vat: 1640.25, capital: 20000 };
  dec.carried = r2(dec.bank + dec.shopify + stock.dec - dec.vat - dec.capital);
  const jun = { shopify: balanceOn('2026-06-30'), vat: 2208.35 };
  jun.profit = r2(OPEN + jun.shopify + stock.jun - jun.vat - dec.capital - dec.carried);
  const opening = {
    dec: [['1020', 'Luzerner Kantonalbank', dec.bank], ['1093', 'Guthaben Shopify Payments', dec.shopify], ['1200', 'Warenlager', stock.dec]],
    decL: [['2201', 'Abrechnungskonto MWST (4. Quartal 2025)', dec.vat], ['2800', 'Stammkapital', dec.capital], ['2970', 'Gewinnvortrag', dec.carried]],
    jun: [['1020', 'Luzerner Kantonalbank', OPEN], ['1093', 'Guthaben Shopify Payments', jun.shopify], ['1200', 'Warenlager', stock.jun]],
    junL: [['2201', 'Abrechnungskonto MWST (2. Quartal 2026)', jun.vat], ['2800', 'Stammkapital', dec.capital], ['2970', 'Gewinnvortrag', dec.carried], ['', 'Gewinn 1.1.–30.6.2026', jun.profit]],
  };
  docs['Bilanz_31.12.2025_Treuhand.pdf'] = balanceSheet({ firm: FIRM, fiduciary: fid, title: 'Bilanz', date: '2025-12-31', assets: opening.dec, liabilities: opening.decL });
  docs['Zwischenbilanz_30.06.2026_Treuhand.pdf'] = balanceSheet({ firm: FIRM, fiduciary: fid, title: 'Zwischenbilanz', date: '2026-06-30', assets: opening.jun, liabilities: opening.junL });
  Object.assign(docs, pay.docs);

  const files = {
    [CAMT]: statement.xml,
    'orders_export_1.csv': csv(ORDER_HEAD, orderRows),
    'payment_transactions_export_1.csv': csv(TX_HEAD, txRows),
    'payouts_export.csv': csv(PAYOUT_HEAD, payoutRows),
  };
  const copies = [[`Kartonage_Rigi_${kartonage.no} (1).pdf`, `Kartonage_Rigi_${kartonage.no}.pdf`]];

  // ─── The answer key ────────────────────────────────────────────────────────
  // The VAT-relevant entries of Q3 as the books should hold them: [day, code, amount (gross; for a -2 code the tax), what].
  const entries = [];
  const sales = orders.filter((o) => sp(o) && inQ3(o.day));
  const stage = new Map();
  const domesticOf = (o) => o.country === 'CH' || o.country === 'LI';
  for (const o of sales) {
    if (!domesticOf(o)) entries.push([o.day, 'V0', o.gross, `${o.no} ${o.country}`]);
    else for (const [rt, t] of Object.entries(o.taxes)) entries.push([o.day, rt === '8.1' ? 'V81' : 'V26', t.base, `${o.no}${o.kind === 'mixed' ? ' (two rates)' : ''}`]);
    for (let i = entries.length - 1; i >= 0 && !stage.has(entries[i]); i--) stage.set(entries[i], o.kind === 'mixed' ? 'mixed' : 'report');
  }
  entries.push([rf.day, '-V81', rf.amount, `${special.refund.no} refund`]);
  stage.set(entries.at(-1), 'report');
  entries.push([d1.day, 'V81', d1.gross, `${d1.no} bank transfer`], [d2.day, 'V81', d2.gross, `${d2.no} bank transfer`], [d2.refundBank.day, '-V81', d2.refundBank.amount, `${d2.no} refunded by bank`]);
  for (const f of feeBills) { entries.push([f.date, 'I81-2', f.vat, `Shopify Payments Invoice ${f.m}`]); stage.set(entries.at(-1), 'bill'); }
  for (const s of subs) entries.push([bankDay(addDays(s.date, 1)), 'I81', s.total, `Shopify Rechnung ${s.no}`]);
  entries.push(['2026-07-29', 'M81-2', customs.vat, 'import VAT, assessment'], ['2026-07-29', 'M81', r2(dhl.fee + dhl.feeVat), 'DHL Vorlageprovision']);
  entries.push(['2026-08-06', 'M81', kartonage.total, 'Kartonage Rigi'], ['2026-09-02', 'M26', teeimport.total, 'Teeimport Basel'], ['2026-08-21', 'M81', landi.total, 'LANDI packaging']);
  for (const b of post) entries.push([b.paid, 'I81', r2(b.domNet + b.vat), `Post ${b.no} domestic`]);

  const ziffern = vatBoxes(entries);
  const upTo = (kinds) => vatBoxes(entries.filter((e) => kinds.includes(stage.get(e) ?? 'bank')));
  const stages = [
    ['after drop 1 (statement, PDFs and photos; no Shopify export, no Payments Invoice)', upTo(['bank'])],
    ['after drop 2 (orders and payments exports in; the mixed cart held)', upTo(['bank', 'report'])],
    ['the mixed cart booked by rate (by her or the AI)', upTo(['bank', 'report', 'mixed'])],
    ['after drop 3 (the Payments Invoices): the final figures above', ziffern],
  ];
  const boxes = [...new Set(stages.flatMap(([, z]) => Object.keys(z)))].sort();
  const fees = sum(q3tx, (t) => t.fee);
  const clearingApp = r2(sum(sales, (o) => o.gross) - rf.amount - fees - sum(q3payouts, (p) => p.total));
  const heldMixed = special.mixed;
  const k = (x) => chf(x);
  const counts = {
    orders: q3orders.length, lines: orderRows.length,
    sp: sales.length, d81: sales.filter((o) => domesticOf(o) && o.kind !== 'mixed' && Object.keys(o.taxes)[0] === '8.1').length, d26: sales.filter((o) => domesticOf(o) && o.kind !== 'mixed' && Object.keys(o.taxes)[0] === '2.6').length,
    exports: sales.filter((o) => !domesticOf(o)).length, payments: rows.length, payouts: q3payouts.length, txRows: txRows.length,
  };
  const other = rows.filter((r) => r.kind !== 'payout');
  const becomes = {
    kyoto: '4200 / 1020, M0 (goods abroad, no Swiss VAT; the import VAT comes with the customs bill). Paid in CHF from the CHF account: it tests no exchange rate',
    dhl: `4030 import VAT CHF ${k(customs.vat)} no code, then – / 4030 M81-2 CHF ${k(customs.vat)} from the assessment (Ziffer 400); 4040 Vorlageprovision CHF ${k(r2(dhl.fee + dhl.feeVat))} M81`,
    kartonage: 'packaging: 4xxx / 1020 M81, or an operating-cost account (6xxx, as 6280) with I81: the tax is equal, only 400 and 405 split differently (receipt: the Kartonage PDF; its copy «(1)» is a duplicate)',
    teeimport: '4200 / 1020, M26 (2.6 % on the invoice)',
    subscription: '6xxx IT / 1020, I81 (the Shopify Rechnung of the month)',
    post: 'shipping costs / 1020: the domestic part with I81 (or M81), the part abroad at 0 % without input tax',
    landi: 'packaging: 4xxx M81 or 6xxx I81, as Kartonage (the photo IMG_2231)',
    deposit: '1020 / 3200, V81 (a sale by bank transfer: the order export counts it, the bank books it)',
    'deposit-refund': `3200 or 3800 (sales reductions) / 1020, -V81: the refund of the order paid by bank transfer; its document is the credit note Gutschrift_GS-2026-007_${d2.no.slice(1)}.pdf`,
    wage: 'the net wage of its payslip: (a) or (b) under «Wages and contributions»; no VAT code (I0 on a wage is a low finding, no figure)',
    ahv: `(a) 2270 CHF ${chf(pay.ahv.employee)} + 5700 CHF ${chf(pay.ahv.employer)}, or (b) 5700 whole; no VAT code`,
    bvg: `(a) 2270 CHF ${chf(pay.bvg.employee)} + 5720 CHF ${chf(pay.bvg.employer)}, or (b) 5720 whole; no VAT code`,
    estv: '2201 (or 2200) / 1020, no VAT code: the Q2 VAT of the interim balance per 30.06. paid',
    fee: '6940 / 1020, no VAT code, the bank\'s own fee row',
  };
  const key = [
    `# Answer key: ${FIRM.name}, Q3 2026`,
    '',
    `Generated by \`node .claude/skills/verify/persona-files.mjs --key webshop\` from the same simulation as the files. Firm ${FIRM.name}, UID ${UID}, IBAN ${spaced(IBAN)} (Luzerner Kantonalbank), effective method, cash basis, quarterly.`,
    '',
    '## The VAT of Q3 (Ziffern, as the books should declare them)',
    '',
    table(['Ziffer', 'CHF'], Object.entries(ziffern).map(([z, v]) => [z, k(v)])),
    '',
    `The mixed cart ${heldMixed.no} (${dmy(heldMixed.day)}, CHF ${k(heldMixed.gross)}: ${Object.entries(heldMixed.taxes).map(([rt, t]) => `${k(t.base)} at ${rt} %`).join(', ')}) is in these figures split by rate. The app cannot read two rates off one tax column and holds it («rate»); until the person books it, 303 and 313 lack its parts and the clearing account lacks CHF ${k(heldMixed.gross)}.`,
    `Without the three Shopify Payments Invoices (she forgets them at first) 405 is CHF ${k(sum(feeBills, (f) => f.vat))} lower: the fees stay on 6580 with I0. The September invoice is dated ${dmy(feeBills[2].date)}.`,
    'Packaging (Kartonage, LANDI) on a material account with M81 or on an operating-cost account with I81 are both right: the tax is the same, only 400 and 405 split differently. The refund by bank on 3200 or 3800 with -V81: both right.',
    '',
    '### The figures at each stage of the walk (checkpoint 12)',
    '',
    table(['Ziffer', ...stages.map(([t]) => t)], boxes.map((b) => [b, ...stages.map(([, z]) => (z[b] === undefined ? '–' : k(z[b])))])),
    '',
    `Without the customs assessment, 400 is CHF ${k(customs.vat)} lower (the import VAT stays a cost on 4030).`,
    '',
    '## Shopify',
    '',
    `- Orders export: ${counts.orders} orders on ${counts.lines} rows (an order of several items has a row per item, the figures on its first). Shopify Payments collected ${counts.sp} of them in Q3 (by Paid at): ${counts.d81} domestic at 8.1 % (one to Liechtenstein, ${special.li.no}, still 8.1 %), ${counts.d26} domestic at 2.6 %, ${counts.exports} abroad without Swiss VAT (V0, Ziffer 220), and the mixed cart ${heldMixed.no}.`,
    `- Counted, never booked onto the clearing account: ${d1.no} and ${d2.no} (Payment Method «Bank Deposit»: their money is on the bank statement) and the test order ${special.test.no} (gateway «bogus»).`,
    `- The refund: ${special.refund.no} of ${dmy(special.refund.day)}, CHF ${k(rf.amount)} back on ${dmy(rf.day)} (the refund row of the payments export), booked 3200 / 1093 with -V81 on that day, not on the order's.`,
    `- Payments transactions export: ${counts.txRows} rows (charges and the refund). Fees of Q3: CHF ${k(fees)} on 6580 / 1093 with I0, each charge on its day; per month ${feeBills.map((f) => `${MONTH[f.m]} ${k(f.fees)}`).join(', ')}.`,
    `- Shopify Payments Invoices (no payment, the VAT in the fees): ${feeBills.map((f) => `${MONTH[f.m]} CHF ${k(f.vat)}`).join(', ')}, each booked once as – / 6580 with the tax-only code (I81-2, or M81-2 when the firm's file says so).`,
    `- Payouts on the statement: ${counts.payouts}, total CHF ${k(sum(q3payouts, (p) => p.total))}, each 1020 / 1093 without a VAT code. The first one (${dmy(q3payouts[0].day)}, CHF ${k(q3payouts[0].total)}) pays charges of late June.`,
    `- The cut-over day the app should propose: ${dmy(Q3.from)} (the first day of the orders export). A clearing account of the balance sheet for what Shopify holds (the chart's 1093, whatever its name), the revenue account (3200, which the app may take from the setup's «what you sell» without asking), fees 6580 with I0.`,
    `- Shopify's own balance (charges not yet paid out, net of fees): CHF ${k(balanceOn('2026-06-30'))} on 30.06., CHF ${k(balanceOn(Q3.to))} on 30.09.`,
    `- Clearing account 1093 on 30.09. from the Q3 files alone (Q3 orders, refund and fees, less the Q3 payouts): CHF ${k(clearingApp)}, and CHF ${k(r2(clearingApp - heldMixed.gross))} while the mixed cart is held. With the interim balance's 1093 of CHF ${k(jun.shopify)} per 30.06. it is Shopify's CHF ${k(balanceOn(Q3.to))}: the first July payouts paid June's sales. With only the 31.12.2025 opening (CHF ${k(dec.shopify)}) it is CHF ${k(r2(clearingApp + dec.shopify))}, off by the first half year's change. A negative balance on the way has the same cause.`,
    '',
    `## The ${counts.payments} payments of the statement`,
    '',
    `${counts.payouts} payouts (Stripe Technology Europe Ltd, «SHOPIFY PAYOUT …»): 1020 / 1093, no VAT code, no receipt needed. The other ${other.length}:`,
    '',
    table(['day', 'who', 'CHF', 'should become'], other.map((r) => [dmy(r.date), r.who, `${r.dir === 'CRDT' ? '+' : '-'}${k(r.amount)}`, becomes[r.kind]])),
    '',
    `Opening balance of the statement CHF ${k(OPEN)} on 01.07., closing CHF ${k(statement.close)} on 30.09. Every entry carries its own reference on the entry (LUKB-26-…).`,
    '',
    '## Wages and contributions',
    '',
    ...pay.keyLines,
    '',
    '## Opening balances',
    '',
    `The fiduciary kept the first half year: \`Bilanz_31.12.2025_Treuhand.pdf\` and \`Zwischenbilanz_30.06.2026_Treuhand.pdf\`. The app takes an opening per 1 January under Firma › Eröffnung; books that begin mid-year are an open question (issue #358). Acceptable:`,
    '',
    `- the opening per 1.1.2026: ${opening.dec.concat(opening.decL).map(([a, nm, v]) => `${a} ${nm} CHF ${k(v)}`).join(', ')}. 1020 then differs from the statement's opening on 01.07. by the first half year's movements (CHF ${k(r2(OPEN - dec.bank))}), which the app should state as a fact;`,
    `- the balances per 30.06.2026, if the app offers a start mid-year: ${opening.jun.concat(opening.junL).map(([a, nm, v]) => `${a || '–'} ${nm} CHF ${k(v)}`).join(', ')}.`,
    '',
    '## The files',
    '',
    `- \`payouts_export.csv\`: Shopify's payouts list (Finanzen › Auszahlungen), the file she finds first. Not a report the app books from (no order column): the app must say what it is not and which export it needs (Bestellungen › Exportieren, and Finanzen › Transaktionen).`,
    `- \`IMG_2240.jpg\`: a product photo, no receipt. \`Kartonage_Rigi_${kartonage.no} (1).pdf\`: a duplicate.`,
    `- Every payment out has its document among the files: the wages their payslips, the contributions their bills, the ESTV payment the interim balance's 2201, the refund by bank the credit note, the bank's fee row the statement itself.`,
    'A walk in mid-November opens the app in Q4 until the first drop: the files are Q3. Finding the period of the files is checkpoint 11.',
  ].join('\n');

  const summary = [
    `- ${counts.payments} payments on the statement, ${counts.payouts} of them Shopify payouts; ${counts.orders} orders in the orders export (${counts.exports} abroad, 1 refunded through Shopify, 2 paid by bank transfer, 1 test order, 1 mixed cart at two rates).`,
    `- Ziffer 200 about CHF ${chf(Math.round(ziffern['200'])).slice(0, -3)}, tax payable (500) about CHF ${chf(Math.round(ziffern['500'] ?? -ziffern['510'])).slice(0, -3)}; Ziffern in whole francs: ${Object.entries(ziffern).map(([b, v]) => `${b} ${chf(Math.round(v)).slice(0, -3)}`).join(', ')}; the exact figures, the clearing account and every payment: \`answer-key.md\`.`,
    `- Tax payable (500, or 510 a credit) at each stage of the walk: ${stages.map(([t, z]) => `${t.split(' (')[0]}: ${z['500'] !== undefined ? '500 ' + chf(Math.round(z['500'])).slice(0, -3) : '510 ' + chf(Math.round(z['510'])).slice(0, -3)}`).join('; ')}.`,
  ].join('\n');

  return {
    files, docs, photos, copies, key, summary, entries,
    env: `PERSONA=webshop\nPERSONA_IBAN=${IBAN}\nPERSONA_IBAN_SPACED='${spaced(IBAN)}'\nPERSONA_UID=${UID}\nPERSONA_CAMT=${CAMT}\nPERSONA_ORDERS=orders_export_1.csv\nPERSONA_FEES=payment_transactions_export_1.csv\n`,
  };
}
