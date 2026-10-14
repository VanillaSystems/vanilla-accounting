/**
 * Things bought on tutti.ch for the company, paid in cash or by TWINT out of the owner's
 * pocket. There is no receipt: the chat with the seller is the only record of what was bought
 * and the price agreed. See docs/runbooks/receipt-collection.md § tutti.ch.
 *
 *   npm run tutti -- export            every buying chat → data/tutti/conversations.json (Aside browser)
 *   npm run tutti -- propose           new chats → data/tutti/purchases.json: bought or not, item, agreed price
 *   npm run tutti -- import [--apply]  purchases with business: true → chat PDF in receipts/ +
 *                                      manual transaction (Auslage, paid privately) + link
 *
 * Re-runnable at every step. `export` keeps chats it saw before (tutti drops old ones). `propose`
 * only asks about chats it has no proposal for, or whose messages changed, and never touches an
 * entry a person decided (`business` set). `import` skips purchases already imported.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Index } from '../types/index.js';
import { loadBooks, periodLock, saveBooks, type Books, update, moduleActor } from '../books/store.js';
import { ask } from '../llm/ask.js';
import { openWorkspace } from '../workspace/workspace.js';

const execFileAsync = promisify(execFile);
const ws = openWorkspace();
const { name: COMPANY, owner: OWNER, business } = ws.company;
const DIR = join(ws.paths.data, 'tutti');
const CONVERSATIONS = join(DIR, 'conversations.json');
const PURCHASES = join(DIR, 'purchases.json');
const BUYING = 'https://www.tutti.ch/de/messages/buying';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface Message { from: 'me' | 'seller'; text: string; at: string; date: string | null }
export interface Conversation {
  id: string;
  url: string;
  title: string;
  /** What the chat header shows above the messages: seller name, member since, listing state, price. */
  header: string;
  messages: Message[];
  exportedAt: string;
}
export interface Purchase {
  conversationId: string;
  title: string;
  seller: string;
  bought: boolean;
  item: string;
  askingPrice: number | null;
  agreedPrice: number | null;
  currency: 'CHF';
  /** The handover day: the day the cash changed hands. */
  date: string | null;
  payment: 'cash' | 'twint' | 'unknown';
  /** The message(s) that show the agreement and the handover. */
  evidence: string;
  /** What the model would decide: company equipment or private. A suggestion only. */
  suggestBusiness: boolean;
  why: string;
  /** Set by a person: true → import as an Auslage, false → private. Null until decided. */
  business: boolean | null;
  messagesHash: string;
  imported?: { ref: string; receipt: string };
}

const load = <T>(p: string, empty: T): T => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : empty);
const save = (p: string, v: unknown) => { mkdirSync(DIR, { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── tutti dates ─────────────────────────────────────────────────────────────
// The chat shows "11. Aug., 8:41", "3. Mai, 16:42", "Dienstag, 21:12", "Gestern, 9:10" or a bare
// time for today; a year only when it is not the current one.
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mär: 3, märz: 3, apr: 4, mai: 5, jun: 6, juni: 6, jul: 7, juli: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dez: 12 };
const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function tuttiDate(at: string, seen: Date): string | null {
  const s = at.trim().toLowerCase();
  const back = (days: number) => { const d = new Date(seen); d.setDate(d.getDate() - days); return iso(d); };
  if (/^(heute, )?\d{1,2}:\d{2}$/.test(s)) return iso(seen);
  if (s.startsWith('gestern')) return back(1);
  const wd = WEEKDAYS.findIndex((w) => s.startsWith(w));
  if (wd >= 0) return back(((seen.getDay() - wd + 7) % 7) || 7);
  const m = s.match(/^(\d{1,2})\.\s*([a-zäöü]+)\.?(?:\s+(\d{4}))?/);
  if (!m || !MONTHS[m[2]]) return null;
  let year = m[3] ? +m[3] : seen.getFullYear();
  const d = new Date(year, MONTHS[m[2]] - 1, +m[1]);
  if (!m[3] && d > seen) d.setFullYear(--year);
  return iso(d);
}

// ── export (Aside) ──────────────────────────────────────────────────────────
async function aside(script: string): Promise<unknown> {
  const { stdout } = await execFileAsync('aside', ['repl', script], { maxBuffer: 20 * 1024 * 1024, timeout: 150_000 });
  const json = stdout.split('JSON_START')[1]?.split('JSON_END')[0];
  if (!json) throw new Error(`aside returned no data: ${stdout.slice(-400)}`);
  return JSON.parse(json);
}

// Page scripts: no single quotes anywhere (aside repl takes the script as one argument, but the
// skill's shell-quoted form is what people copy when debugging).
const LIST_SCRIPT = `
const pg = await openTab("${BUYING}");
await new Promise(r => setTimeout(r, 5000));
const hrefs = () => pg.evaluate(() => [...new Set([...document.querySelectorAll("a[href*=\\"/messages/buying/\\"]")].map(a => a.href))]);
let prev = -1;
for (let i = 0; i < 30; i++) {
  const n = (await hrefs()).length; if (n === prev) break; prev = n;
  await pg.evaluate(() => document.querySelectorAll("*").forEach(e => { if (e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; }));
  await new Promise(r => setTimeout(r, 2000));
}
const rows = await pg.evaluate(() => [...document.querySelectorAll("a[href*=\\"/messages/buying/\\"]")].map(a => ({ url: a.href, preview: a.innerText })));
console.log("JSON_START"); console.log(JSON.stringify(rows)); console.log("JSON_END");
await closeTab(pg);
`;

const chatScript = (url: string) => `
const pg = await openTab("${url}");
await new Promise(r => setTimeout(r, 4000));
const data = await pg.evaluate(() => {
  const lists = [...document.querySelectorAll("[role=list]")];
  const list = lists[lists.length - 1];
  const messages = [...list.querySelectorAll("[role=listitem]")].map(li => {
    const lines = li.innerText.split("\\n").map(s => s.trim()).filter(Boolean);
    const at = lines.length > 1 && /\\d{1,2}:\\d{2}$/.test(lines[lines.length - 1]) ? lines.pop() : "";
    // Own messages are pushed to the right of the chat (flex-end); the seller's stay left.
    return { mine: getComputedStyle(li).justifyContent === "flex-end", text: lines.join("\\n"), at };
  });
  const panel = list.closest("[role=tabpanel]") ?? document.body;
  const all = panel.innerText;
  const first = messages[0]?.text.split("\\n")[0] ?? "";
  const header = (first && all.includes(first) ? all.slice(0, all.indexOf(first)) : all.slice(0, 600)).trim();
  return { header, messages };
});
console.log("JSON_START"); console.log(JSON.stringify(data)); console.log("JSON_END");
await closeTab(pg);
`;

async function exportChats() {
  const seen = new Date();
  const known = load<Conversation[]>(CONVERSATIONS, []);
  const rows = (await aside(LIST_SCRIPT)) as { url: string; preview: string }[];
  console.log(`${rows.length} buying chats on tutti.ch`);
  for (const row of rows) {
    const id = row.url.split('/').pop()!;
    const title = row.preview.split('\n')[0].trim();
    const chat = (await aside(chatScript(row.url))) as { header: string; messages: { mine: boolean; text: string; at: string }[] };
    // A message without its own time belongs to the time shown below the next one.
    const messages: Message[] = [];
    let at = '';
    for (const m of [...chat.messages].reverse()) {
      at = m.at || at;
      messages.unshift({ from: m.mine ? 'me' : 'seller', text: m.text, at, date: tuttiDate(at, seen) });
    }
    const c: Conversation = { id, url: row.url, title, header: chat.header, messages, exportedAt: seen.toISOString() };
    const i = known.findIndex((k) => k.id === id);
    if (i >= 0) known[i] = c; else known.push(c);
    console.log(`  ${messages[messages.length - 1]?.date ?? '?'}  ${title}  (${messages.length} messages)`);
    save(CONVERSATIONS, known);
  }
  console.log(`\n✓ ${known.length} chats in ${CONVERSATIONS}`);
}

// ── propose (model) ─────────────────────────────────────────────────────────
const transcript = (c: Conversation) =>
  c.messages.map((m) => `[${m.date ?? m.at}] ${m.from === 'me' ? `${OWNER} (buyer)` : 'Seller'}: ${m.text}`).join('\n');

function proposePrompt(c: Conversation): string {
  return `A tutti.ch chat in which ${OWNER}, owner of ${COMPANY}${business ? ` (${business})` : ''}, tried to buy a second-hand item. The owner pays in cash or TWINT out of their own pocket at the handover.

Listing title: ${c.title}
Chat header: ${c.header.replace(/\s+/g, ' ').slice(0, 400)}

${transcript(c)}

Decide from the chat only:
- bought: true only if the handover happened or was fixed (a time/place to pick up, "komme", "bin da", shipped and arrived) and the seller did not back out. A pickup arranged without any price talk is a purchase at the listing price. A decline, "already sold", ${OWNER} withdrawing the offer, or no answer is false.
- agreedPrice: the final CHF price both sides accepted (not the asking price); the listing price when they never negotiated and the header shows it; null if not bought or the price is nowhere in the chat.
- askingPrice: the listing price if the chat or header shows it, else null.
- date: YYYY-MM-DD of the handover (pickup, or arrival if shipped); if unclear, the day the price was agreed.
- payment: cash, twint or unknown.
- item: what was bought, short, in German.
- seller: the seller's name or user name.
- evidence: quote the one or two messages that show the agreement and the handover, verbatim, with their dates.
- suggestBusiness: true when the item fits what the company does (see above) or is equipment or a tool for that work; false for clearly private things. why: one short sentence.

Answer with one JSON object only: {"bought":bool,"item":str,"seller":str,"askingPrice":num|null,"agreedPrice":num|null,"date":str|null,"payment":"cash"|"twint"|"unknown","evidence":str,"suggestBusiness":bool,"why":str}`;
}

async function propose() {
  const chats = load<Conversation[]>(CONVERSATIONS, []);
  const purchases = load<Purchase[]>(PURCHASES, []);
  for (const c of chats) {
    const h = hash(transcript(c));
    const old = purchases.find((p) => p.conversationId === c.id);
    if (old && (old.messagesHash === h || old.business !== null || old.imported)) continue;
    const raw = await ask(proposePrompt(c), { step: 'receipt-collection.guide.yaml#tutti', model: 'sonnet' });
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const p: Purchase = {
      conversationId: c.id, title: c.title, seller: j.seller ?? '', bought: !!j.bought, item: j.item ?? c.title,
      askingPrice: j.askingPrice ?? null, agreedPrice: j.agreedPrice ?? null, currency: 'CHF', date: j.date ?? null,
      payment: j.payment ?? 'unknown', evidence: j.evidence ?? '', suggestBusiness: !!j.suggestBusiness, why: j.why ?? '',
      business: null, messagesHash: h,
    };
    if (old) purchases[purchases.indexOf(old)] = p; else purchases.push(p);
    save(PURCHASES, purchases);
    console.log(`  ${p.bought ? '✓' : '·'} ${p.date ?? '          '} ${String(p.agreedPrice ?? '').padStart(5)}  ${p.item}${p.bought ? (p.suggestBusiness ? '  [Firma?]' : '  [privat?]') : ''}`);
  }
  const open = purchases.filter((p) => p.bought && p.business === null && !p.imported);
  console.log(`\n${open.length} bought item(s) wait for a decision: set "business": true or false in ${PURCHASES}`);
}

// ── import ──────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

function chatPdf(c: Conversation, p: Purchase, out: string) {
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(c.title)}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;margin:32px;font-size:10.5pt}h1{font-size:15pt;margin:0 0 4px}.meta{color:#444;border-bottom:1px solid #999;padding-bottom:8px;margin-bottom:10px}.m{margin:5px 0;padding:5px 8px;border-radius:6px;max-width:75%;white-space:pre-wrap}.me{background:#e8f0fe;margin-left:auto}.seller{background:#f1f1f1}.at{color:#666;font-size:8.5pt}</style>
<h1>tutti.ch Kauf: ${esc(p.item)}</h1>
<div class="meta">Inserat: ${esc(c.title)}<br>Verkäufer: ${esc(p.seller)}<br>Käufer: ${esc(OWNER)} für ${esc(COMPANY)}<br>
Vereinbarter Preis: CHF ${p.agreedPrice!.toFixed(2)}${p.askingPrice ? ` (Inseratpreis CHF ${p.askingPrice.toFixed(2)})` : ''}, bezahlt ${p.payment === 'twint' ? 'per TWINT' : p.payment === 'cash' ? 'bar' : ''} bei Übergabe am ${p.date}, privat ausgelegt<br>
Chat: ${esc(c.url)} (exportiert ${c.exportedAt.slice(0, 10)})</div>
${c.messages.map((m) => `<div class="m ${m.from}"><span class="at">${m.from === 'me' ? esc(OWNER) : esc(p.seller || 'Verkäufer')} · ${esc(m.date ?? m.at)}</span><br>${esc(m.text)}</div>`).join('\n')}`;
  const tmp = mkdtempSync(join(tmpdir(), 'tutti-'));
  writeFileSync(join(tmp, 'chat.html'), html);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file://${join(tmp, 'chat.html')}`], { stdio: 'ignore' });
  if (statSync(out).size < 2000) throw new Error(`${out} is a blank print`);
}

function nextManualRef(index: Index, year: string): string {
  // Same rule as POST /api/transactions/manual: a ref is taken if anything points at it.
  const taken = [...index.transactions.map((t) => t.ref), ...(index.journalEntries ?? []).map((j) => j.transactionRef), ...index.mappings.map((m) => m.transactionRef)]
    .filter((ref) => ref.startsWith(`M${year}-`));
  const max = taken.reduce((mx, ref) => Math.max(mx, parseInt(ref.slice(6), 10) || 0), 0);
  return `M${year}-${String(max + 1).padStart(3, '0')}`;
}

function importApproved(apply: boolean) {
  const index = loadBooks(ws);
  update(index, moduleActor('tutti'), (books) => bookApproved(books, apply));
}

function bookApproved(index: Books, apply: boolean) {
  const chats = load<Conversation[]>(CONVERSATIONS, []);
  const purchases = load<Purchase[]>(PURCHASES, []);
  const lock = periodLock(index);
  const todo = purchases.filter((p) => p.business === true && !p.imported);
  for (const p of todo) {
    const c = chats.find((x) => x.id === p.conversationId)!;
    if (!p.bought || !p.agreedPrice || !p.date) { console.log(`  ! ${p.item}: approved but no agreed price or date — fix the entry first`); continue; }
    // Golden rule 1: nothing new inside a filed quarter. A late find is a correction dated on the
    // first open day; the description keeps the real handover date.
    const late = lock.isClosed(p.date);
    const bookDate = late ? new Date(Date.parse(lock.closedThrough!) + 86_400_000).toISOString().slice(0, 10) : p.date;
    const ref = nextManualRef(index, bookDate.slice(0, 4));
    const file = `${p.date.replace(/-/g, '')}-tutti-${slug(p.item)}.pdf`;
    console.log(`  + ${ref} ${bookDate}${late ? ` (Kauf ${p.date}, Korrektur)` : ''} CHF ${p.agreedPrice.toFixed(2)}  ${p.item}  ← ${file}`);
    index.transactions.push({
      ref, bank: 'manual', source: 'manual', date: bookDate, amount: p.agreedPrice, currency: 'CHF', direction: 'DBIT',
      description: `tutti.ch ${p.seller}: ${p.item}${late ? ` — Korrektur: Kauf vom ${p.date} (Periode abgeschlossen)` : ''}`, remarks: `privat ausgelegt (${p.payment === 'twint' ? 'TWINT' : p.payment === 'cash' ? 'bar' : OWNER}), Beleg = tutti-Chat`,
    });
    if (!apply) continue;
    const out = join(ws.paths.receipts, file);
    chatPdf(c, p, out);
    const content = readFileSync(out);
    const id = createHash('sha256').update(content).digest('hex').substring(0, 16);
    index.receipts.push({
      id, filename: file, originalFilename: file, extractionMethod: 'pdftotext',
      extractedText: execFileSync('pdftotext', ['-layout', out, '-']).toString(),
      fileSize: content.length, indexedAt: new Date().toISOString(), location: 'archived',
      date: p.date, amount: p.agreedPrice, currency: 'CHF',
      description: `tutti.ch / ${p.seller} — ${p.item} (CHF ${p.agreedPrice.toFixed(2)}, ${p.payment === 'twint' ? 'TWINT' : 'bar'}, privat ausgelegt)`,
      hasSwissVat: false, vatSummary: [], kind: 'invoice', kindBy: 'human', kindRule: 'tutti chat',
    });
    index.mappings.push({ transactionRef: ref, receiptId: id, by: 'human' });
    p.imported = { ref, receipt: file };
  }
  if (!apply) { console.log(`\nDRY RUN — ${todo.length} approved. Pass --apply to write.`); return; }
  saveBooks(ws, index);
  save(PURCHASES, purchases);
  console.log(`\n✓ imported ${todo.filter((p) => p.imported).length}. Book them with the booking flow (private sale: no MWST → I0/M0).`);
}

const cmd = process.argv[2];
if (cmd === 'export') await exportChats();
else if (cmd === 'propose') await propose();
else if (cmd === 'import') importApproved(process.argv.includes('--apply'));
else { console.error('usage: npm run tutti -- export | propose | import [--apply]'); process.exit(1); }
