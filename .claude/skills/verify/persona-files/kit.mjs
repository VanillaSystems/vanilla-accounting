// What every persona's generator shares: identifiers with valid check digits (computed, so no IBAN or
// UID literal sits in the public repo, src/publish/leak-guard.ts), money, days, a seeded random, a
// camt.053 writer, and the ESTV daily rates the app books foreign entries at.
import fs from 'fs';

/** A Swiss IBAN of a 5-digit bank clearing number and a 12-character account. */
export const ibanOf = (bank, account) => { const b = bank + account; const n = BigInt([...`${b}CH00`].map((c) => parseInt(c, 36)).join('')); return `CH${String(98n - (n % 97n)).padStart(2, '0')}${b}`; };
/** Any country's IBAN of its BBAN (the BBAN's own check digits are the caller's). */
export const ibanAny = (cc, bban) => { const n = BigInt([...`${bban}${cc}00`].map((c) => parseInt(c, 36)).join('')); return `${cc}${String(98n - (n % 97n)).padStart(2, '0')}${bban}`; };
/** A Belgian BBAN (Wise Europe's): bank, account, and the mod-97 of both as its last two digits. */
export const beBban = (ten) => { const m = Number(BigInt(ten) % 97n) || 97; return `${ten}${String(m).padStart(2, '0')}`; };
// A UID's check digit is (11 - sum mod 11) mod 11; 10 is no valid digit, so the next number is taken.
export const uidOf = (eight) => {
  const check = (e) => (11 - ([...e].reduce((s, d, i) => s + Number(d) * [5, 4, 3, 2, 7, 6, 5, 4][i], 0) % 11)) % 11;
  let e = eight; while (check(e) === 10) e = String(Number(e) + 1).padStart(8, '0');
  const d = `${e}${check(e)}`; return `CHE-${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
};
export const spaced = (iban) => iban.replace(/(.{4})/g, '$1 ').trim();
export const n = (x) => x.toFixed(2);
export const r2 = (x) => Math.round(x * 100) / 100;
export const r05 = (x) => Math.round(x * 20) / 20;
/** Swiss money as a person reads it: 1'234.50. */
export const chf = (x) => { const [i, d] = Math.abs(x).toFixed(2).split('.'); return `${x < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${d}`; };
export const mulberry32 = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const D = (iso) => new Date(`${iso}T12:00:00Z`);
export const addDays = (iso, k) => { const d = D(iso); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
/** 0 Sunday … 6 Saturday. */
export const weekday = (iso) => D(iso).getUTCDay();
/** The day itself on a weekday, else the Monday after. */
export const bankDay = (iso) => { let d = iso; while ([0, 6].includes(weekday(d))) d = addDays(d, 1); return d; };
export const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
export const dmy = (iso) => iso.split('-').reverse().join('.');
export const quarterOf = (iso) => `${iso.slice(0, 4)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;

/** The ESTV daily sell rates the app books with (reference/estv-daily-rates-2026.json, ADR 0001): rate(currency, day). */
export function estvRates(repo) {
  const { rates } = JSON.parse(fs.readFileSync(`${repo}/reference/estv-daily-rates-2026.json`, 'utf8'));
  return (ccy, day) => { const r = rates[day]?.[ccy]; if (r === undefined) throw new Error(`no ESTV ${ccy} rate for ${day}`); return r; };
}

/**
 * A camt.053 statement in the shape of the demo generator's (tools/demo/camt053.ts), which is the shape
 * the app's reader is tested on (src/providers/camt053/camt053.ts) for Swiss banks and Wise alike: on
 * each entry its amount, RvslInd, Sts/Cd, booking and value day, the bank's reference (AcctSvcrRef, on
 * the entry: Wise's reader takes it only there) and a bank transaction code (BkTxCd); one TxDtls with
 * the amount, the counterparty as Pty/Nm (and its IBAN where the bank names one), the remittance as
 * Ustrd (none on a Wise card payment, as Wise writes it) and AddtlTxInf; AddtlNtryInf; the statement's
 * CreDtTm and FrToDt and its opening (on its first day) and closing balance.
 * rows: { date, dir: 'CRDT'|'DBIT', amount, who, text, code: 'PMNT/RCDT/DMCT', ref, iban?, info?, remittance?: false }
 */
export function camt({ stmtId, created, iban, ccy, owner, bank, open, from, to, rows }) {
  let bal = open;
  for (const r of rows) bal = r2(bal + (r.dir === 'CRDT' ? r.amount : -r.amount));
  const refs = rows.map((r) => r.ref);
  if (refs.some((x) => !x) || new Set(refs).size !== refs.length) throw new Error(`${stmtId}: every entry needs a reference of its own`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const code = (c) => { const [d, f, sub] = c.split('/'); return `<BkTxCd><Domn><Cd>${d}</Cd><Fmly><Cd>${f}</Cd><SubFmlyCd>${sub}</SubFmlyCd></Fmly></Domn></BkTxCd>`; };
  const balance = (cd, amount, date) => `      <Bal>
        <Tp><CdOrPrtry><Cd>${cd}</Cd></CdOrPrtry></Tp>
        <Amt Ccy="${ccy}">${n(Math.abs(amount))}</Amt>
        <CdtDbtInd>${amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd>
        <Dt><Dt>${date}</Dt></Dt>
      </Bal>`;
  const entry = (r) => {
    const party = r.dir === 'DBIT' ? 'Cdtr' : 'Dbtr';
    const acct = r.iban ? `<${party}Acct><Id><IBAN>${r.iban}</IBAN></Id></${party}Acct>` : '';
    return `      <Ntry>
        <Amt Ccy="${ccy}">${n(r.amount)}</Amt>
        <CdtDbtInd>${r.dir}</CdtDbtInd>
        <RvslInd>false</RvslInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><Dt>${r.date}</Dt></BookgDt>
        <ValDt><Dt>${r.date}</Dt></ValDt>
        <AcctSvcrRef>${r.ref}</AcctSvcrRef>
        ${code(r.code)}
        <NtryDtls>
          <TxDtls>
            <Amt Ccy="${ccy}">${n(r.amount)}</Amt>
            <RltdPties><${party}><Pty><Nm>${esc(r.who)}</Nm></Pty></${party}>${acct}</RltdPties>${r.remittance === false ? '' : `
            <RmtInf><Ustrd>${esc(r.text)}</Ustrd></RmtInf>`}
            <AddtlTxInf>${esc(r.text)}</AddtlTxInf>
          </TxDtls>
        </NtryDtls>
        <AddtlNtryInf>${esc(r.info ?? `${r.dir === 'CRDT' ? 'Gutschrift' : 'Belastung'} ${r.who}`)}</AddtlNtryInf>
      </Ntry>`;
  };
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>MSG-${stmtId}</MsgId>
      <CreDtTm>${created}</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>${stmtId}</Id>
      <CreDtTm>${created}</CreDtTm>
      <FrToDt><FrDtTm>${from}T00:00:00</FrDtTm><ToDtTm>${to}T23:59:59</ToDtTm></FrToDt>
      <Acct>
        <Id><IBAN>${iban}</IBAN></Id>
        <Ccy>${ccy}</Ccy>
        <Ownr><Nm>${esc(owner)}</Nm></Ownr>
        <Svcr><FinInstnId><Nm>${esc(bank)}</Nm></FinInstnId></Svcr>
      </Acct>
${balance('OPBD', open, from)}
${balance('CLBD', bal, to)}
${rows.map(entry).join('\n')}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
  return { xml, close: bal };
}

/** A CSV cell as a shop's export quotes it. */
export const csvCell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const csv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** A markdown table. */
export const table = (header, rows) => [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

export const css = `body{font-family:Helvetica,Arial;font-size:12px;margin:40px;color:#222} h1{font-size:20px} table{width:100%;border-collapse:collapse;margin-top:20px} td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left} .r{text-align:right} .small{font-size:10px;color:#555}`;

/**
 * A phone photo of a till receipt: narrow, slightly tilted, greyish paper, with the day and time a till
 * prints. lines: [[text, amount]]; vat: [[rate, tax]]. Each price stands on its item's line with dotted
 * leaders, so the tilt never sets a price beside the next item.
 */
export const tillPhoto = ({ shop, uid, date, time = '12:04', lines, total, vat, paid = 'Karte', tilt = -2, bg = '#6b5d4f' }) => {
  const row = (a, b, bold) => `<div style="display:flex;align-items:baseline;${bold ? 'font-weight:bold;' : ''}"><span>${a}</span><span style="flex:1;border-bottom:1px dotted #999;margin:0 4px"></span><span>${b}</span></div>`;
  return `<body style="margin:0;background:${bg};display:flex;justify-content:center;padding:40px"><div style="transform:rotate(${tilt}deg);background:#f1eee6;width:300px;padding:20px;font-family:Courier;font-size:13px;line-height:1.5;box-shadow:4px 6px 12px #0006">
<center><b>${shop}</b><br>${uid}<br>${dmy(date)} ${time}</center><hr>${lines.map((l) => row(l[0], n(l[1]))).join('')}<hr>${row('TOTAL CHF', n(total), true)}<br>${vat.map(([rate, tax]) => `inkl. MWST ${rate}%: ${n(tax)}<br>`).join('')}${paid}<br>Danke für Ihren Besuch</div></body>`;
};

const MONTH_DE = { '01': 'Januar', '02': 'Februar', '03': 'März', '04': 'April', '05': 'Mai', '06': 'Juni', '07': 'Juli', '08': 'August', '09': 'September', '10': 'Oktober', '11': 'November', '12': 'Dezember' };

/**
 * A small firm's payroll for a quarter, as its documents state it: a payslip per person and month
 * (gross, AHV/IV/EO 5.3 %, ALV 1.1 %, the pension fund's employee contribution, net), the
 * Ausgleichskasse's quarterly Akonto bill (totals per contribution type on the quarter's wage sum, not
 * per party, as such a bill is), and the pension fund's quarterly bill (employee and employer
 * contributions apart, as such a bill states them). Everything a booking of wages and contributions
 * needs is on a document; the key's acceptable ways and the wrong ones follow from it.
 * people: [{ name, role, gross, bvg (employee contribution a month; 0 or absent: not insured) }]
 */
export function payroll({ firm, people, months, ahvFund, bvgFund, ahvDate, bvgDate }) {
  const docs = {};
  for (const p of people) {
    p.ahv = r2(p.gross * 0.053); p.alv = r2(p.gross * 0.011); p.bvg ??= 0;
    p.net = r2(p.gross - p.ahv - p.alv - p.bvg); p.deductions = r2(p.ahv + p.alv + p.bvg);
    for (const m of months) {
      docs[`Lohnabrechnung_2026-${m}_${p.name.split(' ').at(-1).replace('ä', 'ae')}.pdf`] = `<style>${css}</style><h1>${firm.name}</h1><div class=small>${firm.street}, ${firm.city}</div><h2>Lohnabrechnung ${MONTH_DE[m]} 2026</h2><p>${p.name}, ${p.role}</p><table><tr><td>Bruttolohn</td><td class=r>${n(p.gross)}</td></tr><tr><td>AHV/IV/EO 5.3%</td><td class=r>-${n(p.ahv)}</td></tr><tr><td>ALV 1.1%</td><td class=r>-${n(p.alv)}</td></tr>${p.bvg ? `<tr><td>Pensionskasse (BVG), Arbeitnehmerbeitrag</td><td class=r>-${n(p.bvg)}</td></tr>` : ''}<tr><th>Nettolohn, Auszahlung am 25. ${MONTH_DE[m]}</th><th class=r>${n(p.net)}</th></tr></table><p class=small>Die Arbeitgeberbeiträge stehen in der Akontorechnung der ${ahvFund.name}${p.bvg ? ` und in der Beitragsrechnung der ${bvgFund.name}` : ''}.</p>`;
    }
  }
  const wages = r2(people.reduce((s, p) => s + p.gross, 0));
  const sumQ = r2(wages * months.length);
  const ahv = { ahv: r2(sumQ * 0.106), alv: r2(sumQ * 0.022), fak: r2(sumQ * 0.013) };
  ahv.vk = r2(ahv.ahv * 0.02);
  ahv.total = r2(ahv.ahv + ahv.alv + ahv.fak + ahv.vk);
  ahv.employee = r2(people.reduce((s, p) => s + p.ahv + p.alv, 0) * months.length);
  ahv.employer = r2(ahv.total - ahv.employee);
  docs[`${ahvFund.file}_Akonto_Q3_2026.pdf`] = `<style>${css}</style><h1>${ahvFund.name}</h1><div class=small>${ahvFund.addr}</div><p style="margin-top:30px">${firm.name}<br>${firm.street}<br>${firm.city}</p><h2>Akontorechnung ${ahvFund.no}</h2><p>Datum: ${dmy(ahvDate)} &nbsp; Periode: 3. Quartal 2026 &nbsp; Lohnsumme gemäss Meldung: CHF ${chf(sumQ)}</p><table><tr><td>AHV/IV/EO 10.6%</td><td class=r>${n(ahv.ahv)}</td></tr><tr><td>ALV 2.2%</td><td class=r>${n(ahv.alv)}</td></tr><tr><td>Familienausgleichskasse FAK 1.3%</td><td class=r>${n(ahv.fak)}</td></tr><tr><td>Verwaltungskosten 2% der AHV/IV/EO-Beiträge</td><td class=r>${n(ahv.vk)}</td></tr><tr><th>Total CHF</th><th class=r>${n(ahv.total)}</th></tr></table><p class=small>Beiträge von Arbeitgeber und Arbeitnehmenden zusammen. Sozialversicherungsbeiträge unterliegen nicht der MWST.</p>`;
  const insured = people.filter((p) => p.bvg);
  const bvg = insured.length ? { employee: r2(insured.reduce((s, p) => s + p.bvg, 0) * months.length) } : undefined;
  if (bvg) {
    bvg.employer = bvg.employee; bvg.total = r2(bvg.employee + bvg.employer);
    docs[`${bvgFund.file}_Beitragsrechnung_Q3_2026.pdf`] = `<style>${css}</style><h1>${bvgFund.name}</h1><div class=small>${bvgFund.addr}</div><p style="margin-top:30px">${firm.name}<br>${firm.street}<br>${firm.city}</p><h2>Beitragsrechnung ${bvgFund.no}</h2><p>Datum: ${dmy(bvgDate)} &nbsp; Beiträge 3. Quartal 2026, im Voraus</p><table><tr><th>Versicherte Person</th><th class=r>Arbeitnehmer</th><th class=r>Arbeitgeber</th></tr>${insured.map((p) => `<tr><td>${p.name}</td><td class=r>${n(r2(p.bvg * months.length))}</td><td class=r>${n(r2(p.bvg * months.length))}</td></tr>`).join('')}<tr><th>Total CHF ${n(bvg.total)}</th><th class=r>${n(bvg.employee)}</th><th class=r>${n(bvg.employer)}</th></tr></table>`;
  }
  const monthly = r2(people.reduce((s, p) => s + p.deductions, 0));
  const keyLines = [
    `Every figure here stands on a document: the payslips (${people.map((p) => `${p.name}: gross ${chf(p.gross)}, deductions ${chf(p.deductions)}, net ${chf(p.net)} a month`).join('; ')}), the Akonto bill (CHF ${chf(ahv.total)}, by contribution type, not by party)${bvg ? ` and the pension fund's bill (employees CHF ${chf(bvg.employee)}, employer CHF ${chf(bvg.employer)})` : '; no one is insured in a pension fund'}. Which way the app should book wages is an open decision (issue #368): score the books by «consistent and decidable from the documents», not by one variant.`,
    '',
    `- **Acceptable (a), gross:** each month 5000 the gross CHF ${chf(wages)} against 1020 (the net, the bank's payments) and 2270 (the deductions, CHF ${chf(monthly)}); the Akonto payment 2270 CHF ${chf(ahv.employee)} (the employees' AHV/IV/EO and ALV of the three payslips) and 5700 CHF ${chf(ahv.employer)}${bvg ? `; the pension payment 2270 CHF ${chf(bvg.employee)} and 5720 CHF ${chf(bvg.employer)}` : ''}. 2270 is 0.00 on 30.09.`,
    `- **Acceptable (b), net:** each month 5000 / 1020 the net; the Akonto payment whole on 5700${bvg ? ', the pension payment whole on 5720' : ''}; 2270 unused. The expense in total is the same; the gross wage reaches 5000 only when the year's payroll is booked.`,
    `- **Wrong:** wages net and a payment (or part of one) on 2270: 2270 ends in debit with no deductions booked against it. A split of a payment by amounts no document states. Any VAT code on wages or contributions.`,
  ];
  return { docs, people, ahv, bvg, keyLines };
}

/** A balance sheet the fiduciary hands over, as a PDF: rows [account, name, amount] per side. Throws when the sides differ. */
export function balanceSheet({ firm, fiduciary, title, date, assets, liabilities }) {
  const total = (rs) => r2(rs.reduce((s, r) => s + r[2], 0));
  const side = (rs) => rs.map(([a, name, v]) => `<tr><td>${a}</td><td>${name}</td><td class=r>${chf(v)}</td></tr>`).join('');
  if (Math.abs(total(assets) - total(liabilities)) > 0.004) throw new Error(`${title}: the sides differ by ${r2(total(assets) - total(liabilities))}`);
  return `<style>${css}</style><h1>${firm.name}</h1><div class=small>${firm.street}, ${firm.city}</div><h2>${title} per ${dmy(date)}</h2><table><tr><th colspan=3>Aktiven</th></tr>${side(assets)}<tr><th colspan=2>Total Aktiven</th><th class=r>${chf(total(assets))}</th></tr><tr><th colspan=3>Passiven</th></tr>${side(liabilities)}<tr><th colspan=2>Total Passiven</th><th class=r>${chf(total(liabilities))}</th></tr></table><p class=small>Erstellt durch ${fiduciary}. Fremdwährungskonten zum ESTV-Devisenkurs des Stichtags.</p>`;
}

/**
 * The boxes of the effective method's return (modules/ch/return.yaml, tax-codes.yaml) from entries
 * [day, code, amount, what]: a sale code's gross into 200 and its rate box (exports into 220 as a
 * deduction), a refund with the minus, input tax on a gross purchase as its tax share, a -2 code as
 * the tax itself, Bezugsteuer B81-1 net into 383 and deducted in 405; input tax rounded per entry, the tax owed on each rate's total, as the app does. Checked against the app's own
 * engine (vat().figures) when the persona was built.
 */
export function vatBoxes(entries) {
  const z = {};
  const addTo = (box, v) => { z[box] = (z[box] ?? 0) + v; };
  const SALE = { V81: ['303', 8.1], V26: ['313', 2.6], V38: ['343', 3.8] };
  const INPUT = { M: '400', I: '405' };
  for (const [, raw, amount] of entries) {
    const sign = raw.startsWith('-') ? -1 : 1;
    const code = raw.replace(/^-/, '');
    const a = sign * amount;
    if (SALE[code]) { addTo('200', a); addTo(SALE[code][0], a); continue; }
    if (code === 'V0') { addTo('200', a); addTo('220', a); continue; }
    if (code === 'V0-E') { addTo('200', a); addTo('221', a); continue; }
    if (code === 'B81-1') { addTo('383', a); addTo('405', r2(a * 0.081)); continue; }
    const m = /^([MI])(\d+)(-2)?$/.exec(code);
    if (m) { const r = Number(m[2]) / 10; addTo(INPUT[m[1]], m[3] ? a : r2((a * r) / (100 + r))); continue; }
    throw new Error(`no box for ${raw}`);
  }
  const tax = r2((z['303'] ?? 0) * 8.1 / 108.1 + (z['313'] ?? 0) * 2.6 / 102.6 + (z['343'] ?? 0) * 3.8 / 103.8 + (z['383'] ?? 0) * 0.081);
  const out = {};
  for (const b of ['200', '220', '221']) if (z[b]) out[b] = r2(z[b]);
  out['289'] = r2((z['220'] ?? 0) + (z['221'] ?? 0));
  out['299'] = r2((z['200'] ?? 0) - out['289']);
  for (const b of ['303', '313', '343', '383']) if (z[b]) out[b] = r2(z[b]);
  out['399'] = tax;
  for (const b of ['400', '405', '415']) if (z[b]) out[b] = r2(z[b]);
  out['479'] = r2((z['400'] ?? 0) + (z['405'] ?? 0) - (z['415'] ?? 0));
  const payable = r2(tax - out['479']);
  if (payable >= 0) out['500'] = payable; else out['510'] = -payable;
  return out;
}
