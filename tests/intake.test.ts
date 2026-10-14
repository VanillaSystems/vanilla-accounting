/**
 * The inbox processing as the app runs it: a run of the workflow receipt-intake (src/intake/ as
 * its steps). A dropped receipt is read, its VAT facts taken, named, moved and linked, a new
 * payment booked; a second run changes nothing and asks no model; a filed quarter never changes
 * and a statement that would change it gets the run stuck at read; one run at a time for the
 * inbox, a CLI is refused while a step writes; files arriving in the inbox start a run on their
 * own. Runs the real API server on a copy of the demo with tests/support/stub-bin/claude.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Books } from '../src/books/store.js';
import type { CommandResult, RunDetail } from '../src/workflows/model.js';
import { closedPart } from '../src/books/seal.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { booksOnDisk } from './support/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
const CLOSED_REF = '90000000001';
const DROPPED = 'scan-from-phone.pdf';
let api: ApiServer;
let gate = '';
let prompts = '';
let initial: Books;

/** A camt.053 of the demo's Raiffeisen account with one payment of CHF 42.00 on `date`. */
const camt = (id: string, date: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${date}T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">42.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>${date}</Dt></BookgDt><AcctSvcrRef>REF-${id}</AcctSvcrRef><AddtlNtryInf>Stub Shop ${id}</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

before(async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'intake-'));
  gate = join(scratch, 'gate');
  prompts = join(scratch, 'prompts.txt');
  writeFileSync(prompts, '');
  // The model links the receipt to a payment of the filed quarter and to the new open one.
  const answer = { suggestedFilename: '20260510-stub-shop.pdf', date: '2026-05-10', description: 'Stub Shop', amount: 42, currency: 'CHF', confidence: 0.95, matchedTransactionRefs: [CLOSED_REF, 'REF-T1'] };
  api = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_GATE: gate, CLAUDE_STUB_PROMPTS: prompts, CLAUDE_STUB_ANSWER: JSON.stringify(answer) });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  initial = books();
  writeFileSync(join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen/test-T1.xml'), camt('T1', '2026-05-10'));
  // A phone scan: a demo receipt with other bytes, so another file.
  mkdirSync(join(api.root, 'beleg-import'));
  copyFileSync(join(DEMO_ROOT, 'transactional-data/2026/receipts/20260105-example-cloud-invoice-2026-01.pdf'), join(api.root, 'beleg-import', DROPPED));
  appendFileSync(join(api.root, 'beleg-import', DROPPED), '\n% scanned\n');
});
after(() => {
  api?.stop();
  rmSync(dirname(gate), { recursive: true, force: true });
});

const books = (): Books => loadBooks(workspaceAt(api.ws.paths.root));
const INBOX = { kind: 'company', id: 'inbox' };
const start = async (on = api) => (await on.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: INBOX })).json as unknown as CommandResult & { run: string };
const runOf = async (id: string, on = api) => (await on.send('GET', `/api/automation/runs/${id}`)).json as unknown as RunDetail;
/** The run once it rests: done, stuck or waiting. */
async function rested(id: string, on = api): Promise<RunDetail> {
  let r: RunDetail | undefined;
  await until(`run ${id}`, async () => { r = await runOf(id, on); return r.status !== 'queued' && r.status !== 'running'; });
  return r!;
}
const notesOf = (r: RunDetail) => Object.fromEntries(r.steps.map((x) => [x.step, (x.output?.notes ?? []) as unknown[]]));

async function until(what: string, ok: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 1500; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting: ${what}`);
}

const cli = (name: string) => spawnSync(process.execPath, ['--import', 'tsx', `src/cli/${name}.ts`], {
  encoding: 'utf8',
  env: { ...process.env, VANILLA_WORKSPACE: api.root, PATH: `${STUB}:${process.env.PATH}`, CLAUDE_STUB_GATE: gate, CLAUDE_STUB_PROMPTS: prompts },
});

test('one run at a time: a start while one runs is that run, a CLI is refused, and the payment is booked once', async () => {
  const started = await start();
  assert.equal(started.ok, true);
  await until('a model call', () => existsSync(`${gate}.started`));

  const again = await start();
  assert.equal(again.run, started.run, 'still the one run');
  const terminal = cli('extract');
  assert.equal(terminal.status, 1, terminal.stdout);
  assert.match(terminal.stderr, /Der Eingang wird schon verarbeitet \(Prozess \d+\)/);

  writeFileSync(gate, '');
  const run = await rested(started.run);
  assert.deepEqual([run.status, run.steps.map((x) => [x.step, x.outcome])], ['done', [['read', 'ok'], ['facts', 'ok'], ['match', 'ok'], ['book', 'ok']]]);
  assert.ok(!existsSync(join(api.root, 'data/intake.lock')), 'the lock is given back');

  const b = books();
  const tx = b.journalEntries.filter((je) => je.transactionRef === 'REF-T1');
  assert.deepEqual(tx.map((je) => [je.date, je.accountDebit, je.amount, je.origin, je.run]), [['2026-05-10', '6570', 42, 'classify', started.run]], 'booked once, by the run');
  const r = b.receipts.find((x) => x.filename === '20260510-stub-shop.pdf');
  assert.ok(r, 'named by the model and archived');
  assert.equal(r.location, 'archived');
  assert.equal(r.originalFilename, DROPPED);
  assert.ok(r.vatExtractedAt, 'its VAT facts were read');
  assert.ok(existsSync(join(api.root, 'transactional-data/2026/receipts', r.filename)) && !existsSync(join(api.root, 'beleg-import', DROPPED)), 'the file moved');
  assert.ok(b.mappings.some((m) => m.receiptId === r.id && m.transactionRef === 'REF-T1' && m.run === started.run), 'linked to the open payment, by the run');
});

test('a filed quarter never changes: no link to its payment, its entries, payments and links as before', async () => {
  const b = books();
  const r = b.receipts.find((x) => x.filename === '20260510-stub-shop.pdf')!;
  assert.ok(!b.mappings.some((m) => m.receiptId === r.id && m.transactionRef === CLOSED_REF), 'no link into the filed quarter');
  const ct = b.config.closedThrough!;
  assert.deepEqual(closedPart(b, ct), closedPart(initial, ct));
  const added = b.journalEntries.filter((je) => !initial.journalEntries.some((x) => x.id === je.id));
  assert.ok(added.length > 0 && added.every((je) => je.date > ct), 'new entries only in the open period');
});

test('a statement with a payment in the filed quarter gets the run stuck at read; nothing is written', async () => {
  const file = join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen/test-C9.xml');
  writeFileSync(file, camt('C9', '2026-02-10'));
  const before = JSON.stringify(booksOnDisk(api.ws));
  writeFileSync(gate, '');
  const run = await rested((await start()).run);
  assert.deepEqual([run.status, run.at, run.steps.map((x) => x.step)], ['stuck', 'read', ['read']]);
  assert.match(run.error ?? '', /Periode geschlossen bis 2026-03-31/);
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'the books are byte-identical');
  rmSync(file);
});

test('idempotent: another run writes the same books and asks the model nothing', async () => {
  const before = JSON.stringify(booksOnDisk(api.ws));
  const asked = readFileSync(prompts, 'utf8');
  const run = await rested((await start()).run);
  assert.equal(run.status, 'done');
  assert.deepEqual(notesOf(run), { read: [], facts: [], match: [], book: [] });
  assert.ok(JSON.stringify(booksOnDisk(api.ws)) === before, 'the books are byte-identical');
  assert.equal(readFileSync(prompts, 'utf8'), asked, 'no model call');
});

test('without a working claude CLI the run reads and imports, and says what waits for the model', async () => {
  const noModel = await startApi('demo');
  try {
    cpSync(DEMO_ROOT, noModel.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
    writeFileSync(join(noModel.root, 'transactional-data/2026/bank-statements/Raiffeisen/test-T2.xml'), camt('T2', '2026-05-12'));
    mkdirSync(join(noModel.root, 'beleg-import'));
    copyFileSync(join(api.root, 'transactional-data/2026/receipts/20260510-stub-shop.pdf'), join(noModel.root, 'beleg-import', DROPPED));
    const run = await rested((await start(noModel)).run, noModel);
    assert.equal(run.status, 'done');
    const notes = notesOf(run);
    assert.deepEqual(notes.match, [{ code: 'noModel', waiting: 1 }]);
    assert.deepEqual(notes.book, [{ code: 'noModel', waiting: 1 }]);
    const b: Books = loadBooks(workspaceAt(noModel.ws.paths.root));
    const r = b.receipts.find((x) => x.filename === DROPPED);
    assert.equal(r?.location, 'staged', 'read, and waiting in the inbox for the model to name it');
    assert.ok(r.extractedText.length > 30, 'its text was read without a model');
    assert.ok(b.transactions.some((t) => t.ref === 'REF-T2'), 'the statement was imported');
  } finally {
    noModel.stop();
  }
});

test('a photo put into the inbox from the Finder or the phone starts a run on its own; Belege lists PDFs only', async () => {
  const before = (await api.send('GET', '/api/automation')).json as unknown as { runs: Array<{ id: string; workflow: string }> };
  const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DwHwYBAB7FA/+WnI5aAAAAAElFTkSuQmCC', 'base64');
  writeFileSync(join(api.root, 'beleg-import', 'IMG_0005.HEIC.icloud'), '');
  writeFileSync(join(api.root, 'beleg-import', 'IMG_0005.PNG'), photo);
  const id = createHash('sha256').update(photo).digest('hex').slice(0, 16);
  const listed = (await api.send('GET', '/api/inbox')).json as unknown as { id: string }[];
  assert.ok(!listed.some((f) => f.id === id), 'Belege shows PDFs only');
  let fresh: string | undefined;
  await until('a run started by the inbox', async () => {
    const now = (await api.send('GET', '/api/automation')).json as unknown as { runs: Array<{ id: string; workflow: string }> };
    fresh = now.runs.find((r) => r.workflow === 'receipt-intake' && !before.runs.some((b) => b.id === r.id))?.id;
    return !!fresh;
  });
  assert.equal((await rested(fresh!)).status, 'done');
  assert.ok(!existsSync(join(api.root, 'beleg-import', 'IMG_0005.PNG')), 'the photo was taken up (wrapped into a PDF)');
});
