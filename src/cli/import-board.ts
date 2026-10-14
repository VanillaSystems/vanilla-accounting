/**
 * ASCII status board for a quarter's document collection.
 *
 * Everything here is derived from disk + the workspace's books.json, so the board
 * cannot drift from reality: re-run it any time to refresh.
 *
 * Usage: npm run board [-- 2026-Q3]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks } from '../books/store.js';
import { filesOfPart, openWorkspace, partDirs } from '../workspace/workspace.js';
import { readBankStatements } from '../workspace/bank-statements.js';
import { loadMailConfig } from '../collect/mail-config.js';

const ws = openWorkspace();
const quarter = process.argv[2] ?? (() => {
  const n = new Date();
  return `${n.getFullYear()}-Q${Math.ceil((n.getMonth() + 1) / 3)}`;
})();
const qm = quarter.match(/^(\d{4})-Q([1-4])$/);
if (!qm) throw new Error(`bad quarter: ${quarter}`);
const year = +qm[1];
const q = +qm[2];
const months = [0, 1, 2].map((i) => `${year}-${String((q - 1) * 3 + 1 + i).padStart(2, '0')}`);
const qFrom = `${months[0]}-01`;
const qTo = new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10);
const inQ = (d?: string) => !!d && d >= qFrom && d <= qTo;

const idx = loadBooks(ws);
const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const staged = ls(ws.paths.inbox);
const archived = filesOfPart(ws.paths, 'receipts').map(([name]) => name);
const all = [...staged, ...archived];

type Row = { label: string; state: string; note: string };
const DONE = '#', PART = '+', BLOCK = '!', TODO = '.';

function bar(state: string) {
  return { [DONE]: '[#]', [PART]: '[+]', [BLOCK]: '[!]', [TODO]: '[ ]' }[state] ?? '[ ]';
}

// ── bank data ──────────────────────────────────────────────────────────────
const bankRows: Row[] = [];
// One row pair per bank of the manifest; a bank sends one monthly PDF per currency account.
const currenciesByBank = new Map<string, string[]>();
for (const a of ws.bankAccounts) {
  if (a.bank === 'manual') continue;
  currenciesByBank.set(a.bank, [...(currenciesByBank.get(a.bank) ?? []), a.currency]);
}
const statementFiles = readBankStatements(ws);
for (const [bank, currencies] of currenciesByBank) {
  const label = `${bank} ${currencies.join('/')}`;
  const files = partDirs(ws.paths, 'statements').flatMap((d) => ls(join(d, bank)));
  const xml = [...new Set(statementFiles.filter((f) => f.status === 'read' && f.account.bank === bank).map((f) => f.file))];
  const pdfs = files.filter((f) => f.endsWith('.pdf') && months.some((m) => {
    const [y, mo] = m.split('-');
    return f.includes(`${y}-${mo}`) || f.includes(`.${mo}.${y}`);
  }));
  bankRows.push({
    label: `${label} camt053`,
    state: xml.length ? DONE : TODO,
    note: `${xml.length} xml file(s)`,
  });
  bankRows.push({
    label: `${label} monthly PDFs`,
    state: pdfs.length >= 3 * currencies.length ? DONE : pdfs.length ? PART : TODO,
    note: `${pdfs.length} of ${3 * currencies.length} expected`,
  });
}
const txQ = (idx.transactions ?? []).filter((t: any) => inQ(t.date));
bankRows.push({
  label: 'transactions parsed',
  state: txQ.length ? DONE : TODO,
  note: `${txQ.length} in ${quarter}`,
});

// ── email ──────────────────────────────────────────────────────────────────
const journalPath = join(ws.paths.data, 'download-journal.json');
const journal: any[] = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : [];
const mailboxes = existsSync(ws.paths.mail) ? loadMailConfig(ws).mailboxes : [];
const emailRows: Row[] = mailboxes.map(({ label: lbl, address: addr }) => {
  const n = journal.filter((e) => e.account === lbl && inQ((e.date ?? '').slice(0, 10))).length;
  return { label: addr, state: n ? DONE : BLOCK, note: n ? `${n} attachments` : 'not collected' };
});

// ── vendor portals (declared checklist + filename detection) ───────────────
const VENDORS: { label: string; re: RegExp; need: string }[] = [
  { label: 'AliExpress  Tax Invoice PDFs', re: /_payment\.pdf$|aliexpress/i, need: 'CHE-447.613.666 + 8.1%' },
  { label: 'Amazon.de   per-seller Rechnung', re: /amazon/i, need: 'CHE-269.567.571' },
  { label: 'Shopify     monthly bills', re: /shopify-bill/i, need: 'CHE-153.004.184' },
  { label: 'Shopify     Payments fee invoices', re: /shopify-payments/i, need: 'VAT 8.1% line' },
  { label: 'Shopify     order pages', re: /shopify-order/i, need: 'sales records' },
  { label: 'Digitec / Galaxus', re: /digitec|galaxus/i, need: 'invoice PDF' },
  { label: 'OpenAI / ChatGPT', re: /openai|chatgpt/i, need: 'itemized Stripe invoice' },
  { label: 'Anthropic', re: /anthropic/i, need: 'usually via email' },
];
const vendorRows: Row[] = VENDORS.map((v) => {
  const hits = all.filter((f) => v.re.test(f));
  const qHits = hits.filter((f) => months.some((m) => f.includes(m.replace('-', '')) || f.includes(m)));
  return {
    label: v.label,
    state: qHits.length ? PART : TODO,
    note: qHits.length ? `${qHits.length} file(s) for ${quarter}` : v.need,
  };
});

// ── scans + pipeline ───────────────────────────────────────────────────────
const scans = staged.filter((f) => /^20\d{6}-\d{6}\.pdf$/.test(f));
const stagedPdfs = staged.filter((f) => f.endsWith('.pdf'));
const receiptsQ = (idx.receipts ?? []).filter((r: any) => inQ(r.date));
const mapQ = (() => {
  const refs = new Set(txQ.map((t: any) => t.ref));
  return (idx.mappings ?? []).filter((m: any) => refs.has(m.transactionRef));
})();
const jeQ = (idx.journalEntries ?? []).filter((e: any) => inQ(e.date));

const pipelineRows: Row[] = [
  { label: 'phone scans compressed', state: scans.length ? DONE : TODO, note: `${scans.length} staged` },
  { label: 'extract (text + dedup)', state: stagedPdfs.length ? DONE : TODO, note: `${stagedPdfs.length} staged / ${archived.length} archived` },
  { label: 'match (receipt -> transaction)', state: mapQ.length ? PART : TODO, note: `${mapQ.length} mappings on ${quarter} tx` },
  { label: 'classify (journal entries)', state: jeQ.length ? PART : TODO, note: `${jeQ.length} entries in ${quarter}` },
];

// ── render ─────────────────────────────────────────────────────────────────
const W = 72;
const line = (ch = '-') => '+' + ch.repeat(W - 2) + '+';
const out: string[] = [];
out.push(line('='));
const title = `DOCUMENT IMPORT BOARD   ${quarter}   (${qFrom} .. ${qTo})`;
out.push('|' + title.padStart(Math.floor((W - 2 + title.length) / 2)).padEnd(W - 2) + '|');
out.push(line('='));

function section(name: string, rows: Row[]) {
  const done = rows.filter((r) => r.state === DONE).length;
  const head = `${name}  (${done}/${rows.length} complete)`;
  out.push('| ' + head.padEnd(W - 4) + ' |');
  out.push(line('-'));
  for (const r of rows) {
    const left = ` ${bar(r.state)} ${r.label}`;
    const right = r.note;
    const pad = W - 4 - left.length - right.length;
    out.push('|' + left + (pad > 0 ? ' '.repeat(pad) : ' ') + right + '  |');
  }
  out.push(line('='));
}

section('BANK DATA', bankRows);
section('EMAIL ACCOUNTS', emailRows);
section('VENDOR PORTALS', vendorRows);
section('SCANS + PIPELINE', pipelineRows);
out.push(`  legend:  [#] done   [+] partial   [!] blocked   [ ] not started`);
out.push(`  closed period: on or before ${idx.config?.closedThrough} (locked)`);
console.log(out.join('\n'));
