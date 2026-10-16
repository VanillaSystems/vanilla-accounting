/**
 * The inbox after a quarter was filed (persona test corner-33): a payment imported while its
 * quarter was open carries the bank's reference and counterparty; once the quarter is filed, a
 * run of the inbox reads the bank again and must leave that row exactly as filed, so the receipt
 * dropped after the filing gets in. A receipt whose only payment lies in the filed quarter is
 * archived and says so, with no link; a run that fails leaves no file «wird gelesen» forever: the
 * inbox names the failure. Runs the real API server on a copy of the demo with the claude stub.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Books } from '../src/books/store.js';
import type { CommandResult, RunDetail } from '../src/workflows/model.js';
import type { InboxFile } from '../src/types/index.js';
import { closedPart } from '../src/books/seal.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { DEMO_ROOT } from './support/workspace.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
/** An IBAN with its check digits computed, so no IBAN literal sits in the repo (src/publish/leak-guard.ts). */
const ibanOf = (bank: string, account: string): string => {
  const n = BigInt([...`${bank}${account}CH00`].map((c) => parseInt(c, 36)).join(''));
  return `CH${String(98n - (n % 97n)).padStart(2, '0')}${bank}${account}`;
};
const OTHER_IBAN = ibanOf('00762', '011623852957');
const FILED_REF = 'RB-2026-0012';
const LATE = 'Geruest_August.pdf';
const SECOND = 'Farbmix_Gutschrift.pdf';
let api: ApiServer;
let filedRows = '';

/** A camt.053 of the demo's Raiffeisen account, one payment with the bank's reference and counterparty, as a real export has them. */
const camt = (id: string, iban: string, date: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${date}T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">1120.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>${date}</Dt></BookgDt>
<NtryDtls><TxDtls><Refs><AcctSvcrRef>${FILED_REF}</AcctSvcrRef></Refs><Amt Ccy="CHF">1120.00</Amt><CdtDbtInd>DBIT</CdtDbtInd>
<RltdPties><Cdtr><Nm>Gerüstbau Thurtal GmbH</Nm></Cdtr><CdtrAcct><Id><IBAN>${OTHER_IBAN}</IBAN></Id></CdtrAcct></RltdPties>
<RmtInf><Ustrd>Miete Gerüst August</Ustrd></RmtInf></TxDtls></NtryDtls><AddtlNtryInf>Belastung</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const books = (): Books => loadBooks(workspaceAt(api.ws.paths.root));
const transactionsFile = () => readFileSync(join(api.root, 'transactional-data/2026/books/transactions.jsonl'), 'utf8');
const start = async () => (await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } })).json as unknown as CommandResult & { run: string };
/** Reads every 20 ms until `read` gives a value, for 30 s at most. */
async function until<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 1500; i++) {
    const v = await read();
    if (v !== undefined) return v;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const runDetail = async (id: string) => (await api.send('GET', `/api/automation/runs/${id}`)).json as unknown as RunDetail;
const rested = (id: string) => until(`run ${id} to rest`, async () => { const r = await runDetail(id); return r.status === 'queued' || r.status === 'running' ? undefined : r; });
/** The inbox's row of `name` once it names a failure; until the run that read the file rests, the row reads as «wird gelesen». */
const failedOn = (name: string) => until(`the inbox to name a failure on ${name}`, async () => {
  const file = ((await api.send('GET', '/api/inbox')).json as unknown as InboxFile[]).find((f) => f.filename === name);
  assert.ok(file, 'the file is still in the inbox');
  return file.failed ? { ...file, failed: file.failed } : undefined;
});
function drop(name: string, salt: string): void {
  mkdirSync(join(api.root, 'beleg-import'), { recursive: true });
  copyFileSync(join(DEMO_ROOT, 'transactional-data/2026/receipts/20260105-example-cloud-invoice-2026-01.pdf'), join(api.root, 'beleg-import', name));
  appendFileSync(join(api.root, 'beleg-import', name), `\n% ${salt}\n`);
}

before(async () => {
  // The model is sure the late receipt pays the payment that is filed by now.
  const answer = { suggestedFilename: '20260814-geruestbau-thurtal.pdf', date: '2026-08-14', description: 'Gerüstbau Thurtal', amount: 1120, currency: 'CHF', confidence: 0.95, matchedTransactionRefs: [FILED_REF] };
  api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_ANSWER: JSON.stringify(answer) });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  // Imported while Q2 is open: the row keeps the bank's reference and counterparty.
  const res = await api.fetch('/api/statements?name=q2.xml', { method: 'POST', body: camt('Q2', 'CH6580808000000000001', '2026-05-14') });
  assert.equal(res.status, 200, await res.text());
  const t = books().transactions.find((x) => x.ref === FILED_REF)!;
  assert.deepEqual([t.reference, t.counterparty, t.counterpartyIban], ['Miete Gerüst August', 'Gerüstbau Thurtal GmbH', OTHER_IBAN]);
  // Q2 filed: closedThrough moves past the payment, as the filing workflow and `npm run seal --close` do.
  const ledger = join(api.root, 'ledger.json');
  const head = JSON.parse(readFileSync(ledger, 'utf8')) as { config: { closedThrough: string } };
  head.config.closedThrough = '2026-06-30';
  writeFileSync(ledger, JSON.stringify(head, null, 2) + '\n');
  filedRows = transactionsFile();
});
after(() => api?.stop());

test('a receipt dropped after the filing gets in: the run ends, the filed rows are byte-identical', async () => {
  const before = closedPart(books(), '2026-06-30');
  drop(LATE, 'late');
  const run = await rested((await start()).run);
  assert.equal(run.status, 'done', run.error);
  assert.equal(transactionsFile(), filedRows, 'no filed transaction was rewritten');
  assert.deepEqual(closedPart(books(), '2026-06-30'), before);
  assert.ok(!existsSync(join(api.root, 'beleg-import', LATE)), 'the file left the inbox');
});
test('a receipt whose only payment is filed is archived without a link and names that payment', async () => {
  const b = books();
  const r = b.receipts.find((x) => x.originalFilename === LATE);
  assert.ok(r, 'the receipt is in the books');
  assert.equal(r.location, 'archived');
  assert.ok(!b.mappings.some((m) => m.receiptId === r.id), 'no link into the filed quarter');
  assert.equal(r.filedPayment, FILED_REF);
});

test('a run that fails names the failure on the inbox file, and the next run takes the file', async () => {
  const stray = join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen/unknown-account.xml');
  writeFileSync(stray, camt('STRAY', OTHER_IBAN, '2026-08-03'));
  // The file's arrival starts its run, as for a file from the Finder (src/server/background.ts,
  // every 5 s). A start by hand is no fresh read of the inbox. It hands back a run already under
  // way (here the one the arrival of LATE started behind the first test's), which may have
  // scanned the inbox before this drop and so ends done.
  drop(SECOND, 'second');
  const file = await failedOn(SECOND);
  assert.match(file.failed.error, /unknown-account\.xml/);
  const failed = await runDetail(file.failed.run);
  assert.equal(failed.status, 'stuck');
  assert.match(failed.error ?? '', /unknown-account\.xml/);
  rmSync(stray);
  const again = await rested((await start()).run);
  assert.equal(again.status, 'done', again.error);
  assert.deepEqual((await api.send('GET', '/api/inbox')).json, []);
});
