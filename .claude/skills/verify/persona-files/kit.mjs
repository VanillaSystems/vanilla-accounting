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
 * A camt.053 statement as a Swiss bank writes it: every entry with a bank transaction code (BkTxCd),
 * the counterparty as Dbtr or Cdtr, the remittance as Ustrd, and the opening and closing balance.
 * rows: { date, dir: 'CRDT'|'DBIT', amount, who, text, code: 'PMNT/RCDT/DMCT', ref?, iban?, info? }
 */
export function camt({ msgId, created, stmtId, iban, ccy, owner, bank, open, from, to, rows }) {
  let bal = open;
  for (const r of rows) bal = r2(bal + (r.dir === 'CRDT' ? r.amount : -r.amount));
  const code = (c) => { const [d, f, s] = c.split('/'); return `<BkTxCd><Domn><Cd>${d}</Cd><Fmly><Cd>${f}</Cd><SubFmlyCd>${s}</SubFmlyCd></Fmly></Domn></BkTxCd>`; };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const ntry = rows.map((r) => `
      <Ntry><Amt Ccy="${ccy}">${n(r.amount)}</Amt><CdtDbtInd>${r.dir}</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>${r.date}</Dt></BookgDt><ValDt><Dt>${r.date}</Dt></ValDt>
        ${code(r.code)}
        <NtryDtls><TxDtls><Refs><AcctSvcrRef>${r.ref}</AcctSvcrRef></Refs>
          <Amt Ccy="${ccy}">${n(r.amount)}</Amt><CdtDbtInd>${r.dir}</CdtDbtInd>
          <RltdPties>${r.dir === 'CRDT' ? `<Dbtr><Nm>${esc(r.who)}</Nm></Dbtr>${r.iban ? `<DbtrAcct><Id><IBAN>${r.iban}</IBAN></Id></DbtrAcct>` : ''}` : `<Cdtr><Nm>${esc(r.who)}</Nm></Cdtr>${r.iban ? `<CdtrAcct><Id><IBAN>${r.iban}</IBAN></Id></CdtrAcct>` : ''}`}</RltdPties>
          <RmtInf><Ustrd>${esc(r.text)}</Ustrd></RmtInf></TxDtls></NtryDtls>
        <AddtlNtryInf>${esc(r.info ?? `${r.dir === 'CRDT' ? 'Gutschrift' : 'Belastung'} ${r.who}`)}</AddtlNtryInf></Ntry>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>${created}</CreDtTm></GrpHdr>
    <Stmt><Id>${stmtId}</Id>
      <Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>${ccy}</Ccy><Ownr><Nm>${esc(owner)}</Nm></Ownr><Svcr><FinInstnId><Nm>${esc(bank)}</Nm></FinInstnId></Svcr></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="${ccy}">${n(open)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${from}</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="${ccy}">${n(bal)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${to}</Dt></Dt></Bal>${ntry}
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

/** A phone photo of a till receipt: narrow, slightly tilted, greyish paper. lines: [[text, amount]]; vat: [[rate, tax]]. */
export const tillPhoto = ({ shop, uid, lines, total, vat, paid = 'Karte', tilt = -3, bg = '#6b5d4f' }) => `<body style="margin:0;background:${bg};display:flex;justify-content:center;padding:40px"><div style="transform:rotate(${tilt}deg);background:#f1eee6;width:300px;padding:20px;font-family:Courier;font-size:13px;box-shadow:4px 6px 12px #0006">
<center><b>${shop}</b><br>${uid}</center><hr>${lines.map((l) => `<div style="display:flex;justify-content:space-between"><span>${l[0]}</span><span>${n(l[1])}</span></div>`).join('')}<hr><div style="display:flex;justify-content:space-between"><b>TOTAL CHF</b><b>${n(total)}</b></div><br>${vat.map(([rate, tax]) => `inkl. MWST ${rate}%: ${n(tax)}<br>`).join('')}${paid}<br>Danke für Ihren Besuch</div></body>`;

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
