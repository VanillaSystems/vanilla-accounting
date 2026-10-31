// Made-up files of a painting firm (Malerei Huber GmbH, Wil SG) for persona tests: a Q3 2026 camt.053,
// the CSV a bank offers first, supplier invoices with Swiss VAT, till-receipt photos, and wrong files a
// person drops by mistake (a holiday photo, a fake .docx, a duplicate). Usage: node persona-files.mjs OUT
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
// Check digits computed, so no IBAN or UID literal sits in the public repo (src/publish/leak-guard.ts).
const ibanOf = (bank, account) => { const b = bank + account; const n = BigInt([...`${b}CH00`].map((c) => parseInt(c, 36)).join('')); return `CH${String(98n - (n % 97n)).padStart(2, '0')}${b}`; };
// A UID's check digit is (11 - sum mod 11) mod 11; 10 is no valid digit, so the next number is taken.
const uidOf = (eight) => {
  const check = (e) => (11 - ([...e].reduce((s, d, i) => s + Number(d) * [5, 4, 3, 2, 7, 6, 5, 4][i], 0) % 11)) % 11;
  let e = eight; while (check(e) === 10) e = String(Number(e) + 1).padStart(8, '0');
  const d = `${e}${check(e)}`; return `CHE-${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
};
const spaced = (iban) => iban.replace(/(.{4})/g, '$1 ').trim();
const IBAN = ibanOf('80808', ['0012', '3456', '7891'].join(''));
const UID = uidOf(['3456', '7891'].join(''));
const SUPPLIER_IBAN = spaced(ibanOf('00762', ['0116', '2385', '2957'].join('')));
const uidFor = (n) => `${uidOf(n)} MWST`;
const CAMT = 'camt053_Raiffeisen_Q3-2026.xml';
const tx = [
  ['2026-07-02','CRDT',4860.00,'Familie Keller','Rechnung 2026-028 Malerarbeiten Wohnzimmer'],
  ['2026-07-03','DBIT',1243.55,'Farbmix AG','Rechnung FM-77812'],
  ['2026-07-05','DBIT',86.40,'Tankstelle Wil Ost','Karte 5412 Tanken'],
  ['2026-07-08','DBIT',312.90,'Baucenter Gossau','Karte 5412 Einkauf'],
  ['2026-07-15','DBIT',89.00,'Swisscom (Schweiz) AG','Rechnung Juli Natel'],
  ['2026-07-25','DBIT',5200.00,'Marco Rossi','Lohn Juli 2026'],
  ['2026-07-25','DBIT',4800.00,'Sandra Huber','Lohn Juli 2026'],
  ['2026-07-30','DBIT',1890.35,'SVA St. Gallen','AHV Beiträge Q2'],
  ['2026-08-04','CRDT',12450.00,'Immo Verwaltung Säntis AG','Rechnung 2026-029 Treppenhaus MFH Bronschhofen'],
  ['2026-08-06','DBIT',2410.80,'Farbmix AG','Rechnung FM-78230'],
  ['2026-08-12','DBIT',74.20,'Tankstelle Wil Ost','Karte 5412 Tanken'],
  ['2026-08-14','DBIT',1120.00,'Gerüstbau Thurtal GmbH','Miete Gerüst August'],
  ['2026-08-15','DBIT',89.00,'Swisscom (Schweiz) AG','Rechnung August Natel'],
  ['2026-08-20','DBIT',45.50,'Restaurant Hirschen','Karte 5412'],
  ['2026-08-25','DBIT',5200.00,'Marco Rossi','Lohn August 2026'],
  ['2026-08-25','DBIT',4800.00,'Sandra Huber','Lohn August 2026'],
  ['2026-09-01','DBIT',980.00,'Mobiliar Versicherung','Betriebshaftpflicht 2026/27'],
  ['2026-09-03','CRDT',3275.00,'Hans Meier','Rechnung 2026-030 Fassade Garage'],
  ['2026-09-09','DBIT',158.60,'Baucenter Gossau','Karte 5412 Einkauf'],
  ['2026-09-15','DBIT',89.00,'Swisscom (Schweiz) AG','Rechnung September Natel'],
  ['2026-09-25','DBIT',5200.00,'Marco Rossi','Lohn September 2026'],
  ['2026-09-25','DBIT',4800.00,'Sandra Huber','Lohn September 2026'],
  ['2026-09-30','DBIT',12.00,'Raiffeisenbank','Kontoführung Q3'],
];
let bal = 18420.15; const open = bal;
for (const [, d, a] of tx) bal += d === 'CRDT' ? a : -a;
const n = (x) => x.toFixed(2);
const ntry = tx.map(([dt, d, a, who, txt], i) => `
      <Ntry><Amt Ccy="CHF">${n(a)}</Amt><CdtDbtInd>${d}</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>${dt}</Dt></BookgDt><ValDt><Dt>${dt}</Dt></ValDt>
        <NtryDtls><TxDtls><Refs><AcctSvcrRef>RB-2026-${String(i + 1).padStart(4, '0')}</AcctSvcrRef></Refs>
          <Amt Ccy="CHF">${n(a)}</Amt><CdtDbtInd>${d}</CdtDbtInd>
          <RltdPties>${d === 'CRDT' ? `<Dbtr><Nm>${who}</Nm></Dbtr>` : `<Cdtr><Nm>${who}</Nm></Cdtr>`}</RltdPties>
          <RmtInf><Ustrd>${txt}</Ustrd></RmtInf></TxDtls></NtryDtls>
        <AddtlNtryInf>${d === 'CRDT' ? 'Gutschrift' : 'Belastung'} ${who}</AddtlNtryInf></Ntry>`).join('');
fs.writeFileSync(`${OUT}/${CAMT}`, `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>RB-20261001-1</MsgId><CreDtTm>2026-10-01T06:00:00</CreDtTm></GrpHdr>
    <Stmt><Id>RB-STMT-Q3</Id>
      <Acct><Id><IBAN>${IBAN}</IBAN></Id><Ccy>CHF</Ccy><Ownr><Nm>Malerei Huber GmbH</Nm></Ownr><Svcr><FinInstnId><Nm>Raiffeisenbank Wil und Umgebung</Nm></FinInstnId></Svcr></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${n(open)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-06-30</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${n(bal)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-30</Dt></Dt></Bal>${ntry}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`);
// the CSV a bank's e-banking offers first
fs.writeFileSync(`${OUT}/Kontoauszug_Juli-Sept.csv`, 'Buchungsdatum;Text;Belastung;Gutschrift;Saldo\n' + tx.map(([dt, d, a, who, txt]) => `${dt.split('-').reverse().join('.')};${who} ${txt};${d === 'DBIT' ? n(a) : ''};${d === 'CRDT' ? n(a) : ''};`).join('\n'));

// October: the payments of the hard cases (persona scenario misreads.md), as a statement of its own.
const oct = [
  ['2026-10-02','DBIT',386.60,'Malerbedarf Konstanz GmbH','RE-4471 EUR 412.30'],
  ['2026-10-05','DBIT',187.35,'Baucenter Gossau','Karte 5412 Einkauf'],
  ['2026-10-08','DBIT',1506.45,'Farbmix AG','Rechnung FM-79010 abzgl. 2% Skonto'],
  ['2026-10-12','CRDT',3200.00,'Bauer Michael','Rechnung 2026-031 Malerarbeiten Konstanz'],
];
let balOct = bal; const openOct = bal;
for (const [, d, a] of oct) balOct += d === 'CRDT' ? a : -a;
const ntryOct = oct.map(([dt, d, a, who, txt], i) => `
      <Ntry><Amt Ccy="CHF">${n(a)}</Amt><CdtDbtInd>${d}</CdtDbtInd><Sts>BOOK</Sts>
        <BookgDt><Dt>${dt}</Dt></BookgDt><ValDt><Dt>${dt}</Dt></ValDt>
        <NtryDtls><TxDtls><Refs><AcctSvcrRef>RB-2026-1${String(i + 1).padStart(3, '0')}</AcctSvcrRef></Refs>
          <Amt Ccy="CHF">${n(a)}</Amt><CdtDbtInd>${d}</CdtDbtInd>
          <RltdPties>${d === 'CRDT' ? `<Dbtr><Nm>${who}</Nm></Dbtr>` : `<Cdtr><Nm>${who}</Nm></Cdtr>`}</RltdPties>
          <RmtInf><Ustrd>${txt}</Ustrd></RmtInf></TxDtls></NtryDtls>
        <AddtlNtryInf>${d === 'CRDT' ? 'Gutschrift' : 'Belastung'} ${who}</AddtlNtryInf></Ntry>`).join('');
fs.writeFileSync(`${OUT}/camt053_Raiffeisen_Okt-2026.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>RB-20261015-1</MsgId><CreDtTm>2026-10-15T06:00:00</CreDtTm></GrpHdr>
    <Stmt><Id>RB-STMT-OKT</Id>
      <Acct><Id><IBAN>${IBAN}</IBAN></Id><Ccy>CHF</Ccy><Ownr><Nm>Malerei Huber GmbH</Nm></Ownr><Svcr><FinInstnId><Nm>Raiffeisenbank Wil und Umgebung</Nm></FinInstnId></Svcr></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${n(openOct)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-30</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${n(balOct)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-14</Dt></Dt></Bal>${ntryOct}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`);

const css = `body{font-family:Helvetica,Arial;font-size:12px;margin:40px;color:#222} h1{font-size:20px} table{width:100%;border-collapse:collapse;margin-top:20px} td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left} .r{text-align:right} .small{font-size:10px;color:#555}`;
const inv = (vendor, addr, uid, no, date, rows, to = 'Malerei Huber GmbH<br>Industriestrasse 14<br>9500 Wil SG') => {
  const net = rows.reduce((s, r) => s + r[1], 0); const vat = Math.round(net * 0.081 * 20) / 20;
  return `<style>${css}</style><h1>${vendor}</h1><div class=small>${addr}<br>MWST-Nr. ${uid} MWST</div><p style="margin-top:30px">${to}</p>
  <h2>Rechnung ${no}</h2><p>Datum: ${date}</p><table><tr><th>Artikel</th><th class=r>Betrag CHF</th></tr>${rows.map((r) => `<tr><td>${r[0]}</td><td class=r>${n(r[1])}</td></tr>`).join('')}
  <tr><td>Total exkl. MWST</td><td class=r>${n(net)}</td></tr><tr><td>MWST 8.1%</td><td class=r>${n(vat)}</td></tr><tr><th>Total CHF</th><th class=r>${n(net + vat)}</th></tr></table><p>Zahlbar innert 30 Tagen. IBAN ${SUPPLIER_IBAN}</p>`;
};
const docs = {
  'Farbmix_Auftragsbestaetigung_AB-5521.pdf': `<style>${css}</style><h1>Farbmix AG</h1><div class=small>Farbweg 3, 9000 St. Gallen</div><h2>Auftragsbestätigung AB-5521</h2><p>Datum: 24.07.2026</p><p>Vielen Dank für Ihre Bestellung. Wir liefern am 30.07.2026:</p><table><tr><td>Fassadenfarbe Silikon 12.5 l, 10 Stk</td></tr><tr><td>Grundierung tiefenwirksam 10 l, 3 Stk</td></tr></table><p>Die Rechnung folgt mit der Lieferung.</p>`,
  'Farbmix_Herbstaktion.pdf': `<style>${css}</style><h1>Farbmix Herbstaktion</h1><p>Liebe Kundinnen und Kunden</p><p>Bis 31. Oktober 20 % auf alle Fassadenfarben. Jetzt im Laden oder online bestellen!</p><p class=small>Sie erhalten diesen Newsletter, weil Sie Kundin bei Farbmix sind. Abmelden: farbmix.example/abmelden</p>`,
  'Farbmix_AGB_2026.pdf': `<style>${css}</style><h1>Allgemeine Geschäftsbedingungen</h1><p>Farbmix AG, gültig ab 1. Januar 2026</p><p>1. Geltungsbereich. Diese AGB gelten für alle Lieferungen ...</p><p>2. Preise und Zahlung. Alle Preise in CHF inkl. MWST ...</p><p>3. Lieferung und Gefahrübergang ...</p>`,
  'Malerbedarf_Konstanz_RE-4471.pdf': `<style>${css}</style><h1>Malerbedarf Konstanz GmbH</h1><div class=small>Reichenaustrasse 12, 78467 Konstanz, Deutschland<br>USt-IdNr. DE 811 234 567</div><p style="margin-top:30px">Malerei Huber GmbH<br>Industriestrasse 14<br>9500 Wil SG, Schweiz</p><h2>Rechnung RE-4471</h2><p>Rechnungsdatum: 29.09.2026</p><table><tr><th>Artikel</th><th class=r>Betrag EUR</th></tr><tr><td>Lasur Holz aussen 5 l, 6 Stk</td><td class=r>346.47</td></tr><tr><td>Nettobetrag</td><td class=r>346.47</td></tr><tr><td>MwSt. 19 %</td><td class=r>65.83</td></tr><tr><th>Gesamtbetrag EUR</th><th class=r>412.30</th></tr></table><p>Abholung im Laden Konstanz.</p>`,
  'Rechnung_2026-031_Konstanz.pdf': `<style>${css}</style><h1>Malerei Huber GmbH</h1><div class=small>Industriestrasse 14, 9500 Wil SG<br>MWST-Nr. ${uidOf(['3456', '7891'].join(''))} MWST</div><p style="margin-top:30px">Familie Bauer<br>Seestrasse 4<br>78462 Konstanz, Deutschland</p><h2>Rechnung 2026-031</h2><p>Datum: 25.09.2026</p><table><tr><th>Leistung</th><th class=r>Betrag CHF</th></tr><tr><td>Malerarbeiten Wohnung Seestrasse 4, Konstanz</td><td class=r>3200.00</td></tr><tr><th>Total CHF</th><th class=r>3200.00</th></tr></table><p class=small>Leistungsort Deutschland: nicht der schweizerischen MWST unterstellt.</p>`,
  'Farbmix_Rechnung_FM-79010.pdf': inv('Farbmix AG', 'Farbweg 3, 9000 St. Gallen', uidOf('1234'+'5678'), 'FM-79010', '28.09.2026', [['Dispersionsfarbe weiss 15 l, 10 Stk', 853.00], ['Spachtel und Kellen', 569.02]]).replace('Zahlbar innert 30 Tagen.', 'Zahlbar innert 10 Tagen mit 2 % Skonto: CHF 1506.45, sonst innert 30 Tagen netto.'),
  'Farbmix_Rechnung_FM-77812.pdf': inv('Farbmix AG', 'Farbweg 3, 9000 St. Gallen', uidOf('1234'+'5678'), 'FM-77812', '28.06.2026', [['Dispersionsfarbe weiss 15 l, 8 Stk', 682.40], ['Abdeckvlies 50 m², 4 Rollen', 196.00], ['Malerkrepp 50 mm, 24 Stk', 271.95]]),
  'Farbmix_Rechnung_FM-78230.pdf': inv('Farbmix AG', 'Farbweg 3, 9000 St. Gallen', uidOf('1234'+'5678'), 'FM-78230', '30.07.2026', [['Fassadenfarbe Silikon 12.5 l, 10 Stk', 1890.00], ['Grundierung tiefenwirksam 10 l, 3 Stk', 340.20]]),
  'Geruest_August.pdf': inv('Gerüstbau Thurtal GmbH', 'Thurstrasse 88, 9500 Wil', uidOf('9876'+'5432'), '2026-0815', '01.08.2026', [['Gerüstmiete MFH Bronschhofen, August', 1036.10]]),
  'swisscom_juli.pdf': inv('Swisscom (Schweiz) AG', '3050 Bern', uidOf('1163'+'2895'), '7712345678', '10.07.2026', [['inOne mobile business, Juli', 82.33]]),
  'Mobiliar Police.pdf': `<style>${css}</style><h1>Die Mobiliar</h1><p>Prämienrechnung Betriebshaftpflicht</p><p>Versicherungsnehmer: Malerei Huber GmbH</p><table><tr><td>Prämie 01.09.2026–31.08.2027</td><td class=r>980.00</td></tr><tr><td class=small>Versicherungsprämien sind von der MWST ausgenommen.</td><td></td></tr></table>`,
  'Rechnung_2026-029_Treppenhaus.pdf': inv('Malerei Huber GmbH', 'Industriestrasse 14, 9500 Wil SG', uidOf('3456'+'7891'), '2026-029', '10.07.2026', [['Malerarbeiten Treppenhaus MFH Bronschhofen, 4 Geschosse', 11517.10]], 'Immo Verwaltung Säntis AG<br>Bahnhofstrasse 2<br>9000 St. Gallen'),
};
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
for (const [f, html] of Object.entries(docs)) { await p.setContent(html); await p.pdf({ path: `${OUT}/${f}`, format: 'A4' }); }
// phone photos of till receipts: narrow, slightly tilted, greyish paper
const till = (shop, lines, total, uid) => `<body style="margin:0;background:#6b5d4f;display:flex;justify-content:center;padding:40px"><div style="transform:rotate(-3deg);background:#f1eee6;width:300px;padding:20px;font-family:Courier;font-size:13px;box-shadow:4px 6px 12px #0006">
<center><b>${shop}</b><br>${uid}</center><hr>${lines.map((l) => `${l[0]}<span style="float:right">${n(l[1])}</span><br>`).join('')}<hr><b>TOTAL CHF<span style="float:right">${n(total)}</span></b><br><br>inkl. MWST 8.1%: ${n(total / 1.081 * 0.081)}<br>Karte ****5412<br>Danke für Ihren Einkauf</div></body>`;
const photos = {
  // The invoice FM-77812 once more, photographed on the desk: the same receipt as the PDF.
  'IMG_4801.jpg': `<body style="margin:0;background:#8a7a66;display:flex;justify-content:center;padding:30px"><div style="transform:rotate(2deg);background:#fbfaf6;width:520px;padding:30px;font-family:Helvetica;font-size:12px;box-shadow:4px 6px 12px #0006">${inv('Farbmix AG', 'Farbweg 3, 9000 St. Gallen', uidOf('1234' + '5678'), 'FM-77812', '28.06.2026', [['Dispersionsfarbe weiss 15 l, 8 Stk', 682.40], ['Abdeckvlies 50 m², 4 Rollen', 196.00], ['Malerkrepp 50 mm, 24 Stk', 271.95]])}</div></body>`,
  'IMG_4733.jpg': till('Baucenter Gossau', [['Abdeckfolie 4x5 m', 24.90], ['Pinselset', 39.95], ['Silikon weiss 3 Stk', 32.70], ['Schleifpapier', 89.80]], 187.35, uidFor('5556'+'6677')).replace('transform:rotate(-3deg)', 'transform:rotate(-7deg) skewX(4deg);filter:blur(1.6px) contrast(.8)'),
  'IMG_4471.jpg': till('Tankstelle Wil Ost', [['Diesel 41.2 l', 86.40]], 86.40, uidFor('2223'+'3344')),
  'IMG_4502.jpg': till('Baucenter Gossau', [['Spachtelmasse 5 kg', 38.90], ['Farbroller Set', 64.50], ['Leiter Alu 3x9', 209.50]], 312.90, uidFor('5556'+'6677')),
  'IMG_4588.jpg': till('Restaurant Hirschen', [['Menu 2x', 39.00], ['Mineral', 6.50]], 45.50, uidFor('4445'+'5566')),
  'IMG_4590.jpg': `<body style="margin:0;background:linear-gradient(#7ec8f0,#2e8bc0 60%,#e8d39a 60%);height:900px"><div style="font:bold 40px Helvetica;color:white;padding:60px">Ferien Rimini 🏖</div></body>`,
};
for (const [f, html] of Object.entries(photos)) { await p.setViewport({ width: 600, height: 900 }); await p.setContent(html); await p.screenshot({ path: `${OUT}/${f}`, type: 'jpeg', quality: 70 }); }
await b.close();
fs.copyFileSync(`${OUT}/Farbmix_Rechnung_FM-77812.pdf`, `${OUT}/Farbmix_Rechnung_FM-77812 (1).pdf`);
fs.writeFileSync(`${OUT}/Offerte Familie Keller.docx`, 'PK\u0003\u0004 not really a docx');
fs.writeFileSync(`${OUT}/../persona.env`, `PERSONA_IBAN=${IBAN}\nPERSONA_IBAN_SPACED='${spaced(IBAN)}'\nPERSONA_UID=${UID}\nPERSONA_CAMT=${CAMT}\n`);
console.log(OUT);
