/**
 * Runs a replay on its folder (README.md «The run»): the app's own server on the copy, the steps a
 * person triggers (drop the statements and receipts, «Eingang verarbeiten»), the oracle's two
 * rounds with a run between them, the period's figures, and the tokens the model calls cost per
 * phase, step and model. Every write goes through the app's API, so through its write door and its
 * runs; nothing here writes the books itself.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BankTransaction, JournalEntry } from '../../src/types/index.js';
import type { DropRow, DropSession } from '../../src/types/drop.js';
import type { Question } from '../../src/questions/model.js';
import type { AutomationView } from '../../src/workflows/model.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../../src/workspace/workspace.js';
import { loadBooks, type Books } from '../../src/books/store.js';
import { vat } from '../../src/engines/index.js';
import { loadKnowledge } from '../../src/knowledge/layers.js';
import { ownerAccountNumber } from '../../src/accounting/bank-accounts.js';
import type { LedgerRow } from '../../src/llm/ask.js';
import type { Marker } from './cut.js';
import type { AnswerKey } from './key.js';
import { compare, type CompareOptions, type Verdict } from './compare.js';
import { effectJudge, poolOf, returnCodeKey } from './judge.js';
import { passOf, planFirst, planSecond, touchOf, TOUCH_KINDS, type Action, type CaseView, type Context, type KeySide, type Pass, type TouchKind } from './oracle.js';
import { score, summaryMarkdown, type Phase } from './report.js';

const STUB = fileURLToPath(new URL('./stub-claude.mjs', import.meta.url));

interface Api {
  send<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }>;
  upload(path: string, bytes: Buffer): Promise<{ status: number; json: DropSession }>;
}

/** The app's server on the copy, with this machine's state (runs, approvals, AI settings) kept in the run folder. */
async function startServer(dir: string, repo: string, model: 'stub' | 'real'): Promise<{ api: Api; stop: () => Promise<void>; log: () => string }> {
  const state = join(dir, 'state');
  mkdirSync(state, { recursive: true });
  // The app's defaults per step: the person's own choices on this Mac do not change the benchmark.
  writeFileSync(join(state, 'ai.json'), JSON.stringify({ steps: {}, cli: 'claude' }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VANILLA_WORKSPACE: repo, VANILLA_KEYCHAIN: 'off', VANILLA_RUNS_DIR: join(state, 'runs'), VANILLA_APPROVALS_DIR: join(state, 'approvals'),
    VANILLA_AI_SETTINGS: join(state, 'ai.json'), VANILLA_API_HOST: '127.0.0.1', PORT: '0', VANILLA_PHONE_TOKEN: 'replay', READONLY: '',
    // Codex is never asked: the replay measures the claude CLI alone.
    CODEX_BIN: join(state, 'no-codex'),
    ...(model === 'stub' ? { CLAUDE_BIN: STUB, REPLAY_STUB_LOG: join(state, 'stub-calls.tsv') } : {}),
  };
  if (model === 'real') delete env.CLAUDE_BIN;
  const server: ChildProcess = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(APP_ROOT, 'src/server/main.ts')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  // Kept as it comes: a run that stalls shows where.
  const port = await new Promise<number>((resolve, reject) => {
    server.once('exit', (code) => reject(new Error(`the server exited with ${code}:\n${out.slice(-2000)}`)));
    const take = (chunk: Buffer) => {
      out += chunk.toString();
      appendFileSync(join(state, 'server.log'), chunk);
      const m = out.match(/API server running on port (\d+)/);
      if (m) resolve(Number(m[1]));
    };
    server.stdout!.on('data', take);
    server.stderr!.on('data', take);
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, init: RequestInit) => fetch(base + path, { ...init, headers: { ...init.headers as Record<string, string>, Connection: 'close' } });
  const api: Api = {
    async send<T>(method: string, path: string, body?: unknown) {
      const res = await request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => ({})) as T };
    },
    async upload(path, bytes) {
      const res = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
      return { status: res.status, json: await res.json().catch(() => ({})) as DropSession };
    },
  };
  const kill = () => server.kill('SIGKILL');
  process.once('exit', kill);
  const stop = () => new Promise<void>((resolve) => {
    process.removeListener('exit', kill);
    if (server.exitCode !== null) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(kill, 10_000).unref();
  });
  return { api, stop, log: () => out };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A run that shows no progress this long is stuck: the replay stops and says so rather than wait for ever. */
const STALL_MS = 30 * 60_000;

/** Until no run is running or queued, three looks in a row (a run that ends may start the next). */
async function rest(api: Api, say: (s: string) => void): Promise<void> {
  let calm = 0;
  let last = '';
  let since = Date.now();
  for (;;) {
    const v = (await api.send<AutomationView>('GET', '/api/automation')).json;
    const busy = v.runs.filter((r) => r.status === 'running' || r.status === 'queued');
    calm = busy.length ? 0 : calm + 1;
    if (calm >= 3) return;
    const now = busy.map((r) => `${r.workflow}:${r.status}${r.progress ? ` ${r.progress.done}/${r.progress.total}` : ''}`).join(', ');
    if (now !== last) { say(`  … ${now || 'settling'}`); last = now; since = Date.now(); }
    if (busy.length && Date.now() - since > STALL_MS) throw new Error(`a run shows no progress for ${STALL_MS / 60_000} min: ${now} (state/server.log)`);
    await sleep(2000);
  }
}

/** The ledger's rows so far (the copy's data/llm-ledger.jsonl). */
const ledgerRows = (ws: Workspace): LedgerRow[] => {
  const file = join(ws.paths.data, 'llm-ledger.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerRow) : [];
};

type ProviderAnswers = { clearing?: string; since?: string; revenue?: string; fees?: { account?: string; vat?: string } };

/**
 * What a person at the drop does with a row that waits (README.md «The drop»), from what the real
 * books hold: the provider's accounts as the company's file names them, a statement PDF kept as the
 * month's statement, two files that are both receipts of the books «different», a file the books
 * hold as a receipt taken as one. Each answer is an intake touch.
 */
function rowAction(row: DropRow, provider: ProviderAnswers | undefined, isReceipt: boolean): { did: string; body: Record<string, unknown> } | undefined {
  if (row.state === 'taken' || row.state === 'undone') return undefined;
  if (row.askProvider) {
    const ask = row.askProvider;
    const account = ask.missing === 'fees' ? provider?.fees?.account : ask.missing === 'revenue' ? provider?.revenue : ask.missing === 'clearing' ? provider?.clearing : undefined;
    return {
      did: `provider ${ask.missing}`,
      body: {
        kind: 'provider', ...(account ? { account } : {}), ...(ask.missing === 'fees' && provider?.fees?.vat ? { vat: provider.fees.vat } : {}),
        ...(provider?.since ? { since: provider.since } : {}), ...(ask.revenue && provider?.revenue ? { revenue: provider.revenue } : {}),
        ...(ask.propose && account === ask.propose.account ? { create: true } : {}),
      },
    };
  }
  if (row.payoutUnseen) return { did: 'report taken anyway', body: { kind: 'anyway' } };
  if (row.state === 'asks' && row.kind === 'statement-pdf' && row.read) return { did: 'statement PDF kept', body: { kind: 'keep' } };
  if (row.state === 'duplicate' && row.twin?.relation === 'duplicate' && !row.reason?.startsWith('same')) return { did: isReceipt ? 'twin: different' : 'twin: same', body: { kind: 'twin', answer: isReceipt ? 'different' : 'same' } };
  if ((row.state === 'quarantine' || row.state === 'unclear') && isReceipt) return { did: 'taken as a receipt', body: { kind: 'as', as: 'receipt' } };
  return undefined;
}

async function drop(api: Api, dir: string, key: AnswerKey, providerOf: (id: string) => ProviderAnswers | undefined, say: (s: string) => void): Promise<{ rows: Record<string, number>; touches: Array<{ file: string; did: string; error?: string }> }> {
  let s = (await api.send<DropSession>('POST', '/api/drop')).json;
  const id = s.id;
  // The bank's exports first, then the statements as PDF, then the receipts.
  const order = (i: AnswerKey['inputs'][number]) => (i.kind === 'statement' ? (i.name.toLowerCase().endsWith('.pdf') ? 1 : 0) : 2);
  const inputs = [...key.inputs].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const touches: Array<{ file: string; did: string; error?: string }> = [];
  const receiptIds = new Set(Object.keys(key.receipts));
  for (const [n, input] of inputs.entries()) {
    const r = await api.upload(`/api/drop/${id}/files?name=${encodeURIComponent(input.name)}`, readFileSync(join(dir, input.path)));
    if (r.status !== 200) { say(`  ${input.name}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); continue; }
    s = r.json;
    if ((n + 1) % 25 === 0 || n + 1 === inputs.length) say(`  dropped ${n + 1}/${inputs.length}`);
  }
  // A person answers each row that waits, one at a time on the session as it is now: an answer can change
  // what another row asks (a provider's next account). Each question is answered once.
  const answered = new Set<string>();
  for (;;) {
    const next = s.rows.map((row) => ({ row, a: rowAction(row, row.askProvider ? providerOf(row.askProvider.provider) : undefined, receiptIds.has(row.id)) }))
      .find(({ row, a }) => a && !answered.has(`${row.key}:${a.did}`));
    if (!next) break;
    const { row, a } = next as { row: DropRow; a: NonNullable<ReturnType<typeof rowAction>> };
    answered.add(`${row.key}:${a.did}`);
    const r = await api.send<DropSession>('POST', `/api/drop/${id}/rows/${row.key}`, a.body);
    touches.push({ file: row.name, did: a.did, ...(r.status >= 400 ? { error: `${r.status} ${JSON.stringify(r.json).slice(0, 160)}` } : {}) });
    if (r.status === 200) s = r.json;
  }
  const rows: Record<string, number> = {};
  for (const row of s.rows) { const k = `${row.state}${row.reason ? ` (${row.reason})` : ''}`; rows[k] = (rows[k] ?? 0) + 1; }
  writeFileSync(join(dir, 'state', 'drop.json'), JSON.stringify(s, null, 1));
  await api.send('DELETE', `/api/drop/${id}`);
  return { rows, touches };
}

/** «Eingang verarbeiten»: the inbox's run, started by hand, and its rest. */
async function inboxRun(api: Api, say: (s: string) => void): Promise<void> {
  const r = await api.send<{ ok: boolean; refusal?: string; detail?: string }>('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } });
  if (!r.json.ok) say(`  inbox run: ${r.json.refusal} ${r.json.detail ?? ''}`);
  await rest(api, say);
}

interface State {
  books: Books;
  questions: Question[];
  tasks: Set<string>;
}

async function stateOf(api: Api, ws: Workspace): Promise<State> {
  const questions = (await api.send<{ questions: Question[] }>('GET', '/api/questions')).json.questions ?? [];
  const view = (await api.send<AutomationView>('GET', '/api/automation')).json;
  const tasks = new Set(view.tasks.filter((t) => t.item.kind === 'transaction').map((t) => t.item.id));
  return { books: loadBooks(ws), questions, tasks };
}

/** The payment of the copy a key payment is: the same ref, else the one movement of its account, day, amount and way. */
function refIn(books: Books, tx: BankTransaction): string | undefined {
  if (books.transactions.some((t) => t.ref === tx.ref)) return tx.ref;
  const same = books.transactions.filter((t) => t.bank === tx.bank && t.date === tx.date && t.amount === tx.amount && t.direction === tx.direction && t.currency === tx.currency);
  return same.length === 1 ? same[0].ref : undefined;
}

function viewOf(s: State, ref: string | undefined): CaseView {
  if (!ref) return { ref: '', entries: [], receipts: [] };
  const tx = s.books.transactions.find((t) => t.ref === ref);
  const q = s.questions.find((x) => x.on.kind === 'payment' && x.on.id === ref && x.status === 'open');
  return {
    ref, ...(tx ? { tx } : {}),
    entries: s.books.journalEntries.filter((e) => e.transactionRef === ref),
    receipts: [...new Set(s.books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))],
    ...(q ? { question: { id: q.id, ...(q.topic ? { topic: q.topic } : {}), choices: q.choices } } : {}),
    ...(s.tasks.has(ref) ? { task: true as const } : {}),
  };
}

/**
 * One action through the API; a refusal is returned for the record, never thrown. `ref` undefined: a
 * booking of no payment, which the app gives a ref of its own (the first line's), told to `made`.
 */
async function perform(api: Api, ref: string | undefined, a: Action, made?: (ref: string) => void): Promise<string | undefined> {
  const fail = (what: string, r: { status: number; json: unknown }) => (r.status >= 400 ? `${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}` : undefined);
  if (!ref && a.kind !== 'book') return `${a.kind}: no payment`;
  switch (a.kind) {
    case 'link': {
      for (const receiptId of a.remove) { const e = fail('unlink', await api.send('POST', '/api/mapping/remove', { transactionRef: ref, receiptId })); if (e) return e; }
      for (const receiptId of a.add) { const e = fail('link', await api.send('POST', '/api/mapping/add', { transactionRef: ref, receiptId })); if (e) return e; }
      return undefined;
    }
    case 'noReceipt': return fail('noReceiptNeeded', await api.send('PATCH', `/api/transactions/${encodeURIComponent(ref!)}`, { noReceiptNeeded: true }));
    case 'answer': return fail('answer', await api.send('POST', `/api/questions/${a.question}/answer`, { by: 'Replay', answer: { choice: a.choice } }));
    case 'book': {
      // The key's lines first, then the app's go: the payment is never without a booking, so no run books it meanwhile.
      let own = ref;
      for (const e of a.entries) {
        const body = {
          date: e.date, accountDebit: e.accountDebit, accountCredit: e.accountCredit, amount: e.amount, description: e.description || 'Replay',
          ...(own ? { transactionRef: own } : {}),
          ...(e.vatCode ? { vatCode: e.vatCode } : {}), ...(e.exchangeCurrency ? { exchangeCurrency: e.exchangeCurrency, exchangeRate: e.exchangeRate } : {}), ...(e.corrects ? { corrects: e.corrects } : {}),
        };
        const r = await api.send<{ entry?: JournalEntry }>('POST', '/api/journal-entries', body);
        const err = fail('entry', r);
        if (err) return err;
        if (!own && r.json.entry) { own = r.json.entry.transactionRef; made?.(own); }
      }
      for (const id of a.replace) { const e = fail('delete', await api.send('DELETE', `/api/journal-entries/${id}`)); if (e) return e; }
      return undefined;
    }
  }
}

export interface CaseResult {
  ref: string;
  /** The copy's ref when it differs. */
  as?: string;
  pass: Pass;
  /** After the app's own runs: what differed (silent errors and open ones alike). */
  first: Verdict;
  touches: TouchKind[];
  final: Verdict;
  errors: string[];
}

export type Outside = { ref: string; kind: string; did: string; error?: string };

export async function replay(dir: string, marker: Marker, opts: { model: 'stub' | 'real' }): Promise<void> {
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as AnswerKey;
  const repo = join(dir, 'repo');
  if (existsSync(join(dir, 'result.json'))) throw new Error(`${dir} ran already: a replay starts from a new «prepare»`);
  const ws = workspaceAt(repo);
  const log: string[] = [];
  const say = (s: string) => { console.log(s); log.push(`${new Date().toISOString()} ${s}`); };
  const started = Date.now();
  const phases: Phase[] = [];
  let phase: Phase | undefined;
  const end = () => { if (!phase) return; phase.ledgerTo = ledgerRows(ws).length; phase.ms = Date.now() - Date.parse(phase.startedAt); phases.push(phase); phase = undefined; };
  const begin = (name: string) => { end(); phase = { name, startedAt: new Date().toISOString(), ledgerFrom: ledgerRows(ws).length, ledgerTo: 0, ms: 0 }; say(`▶ ${name}`); };

  // The provider answers a person gives at the drop: the source company's own file of the provider.
  const source = loadKnowledge(APP_ROOT, marker.source).counterparties;
  const providerOf = (id: string) => source.find((c) => c.id === id)?.provider as ProviderAnswers | undefined;
  say(`Replay of ${key.period} (${marker.arm}), model ${opts.model}: ${key.cases.length} payments, ${key.inputs.length} files`);
  const { api, stop } = await startServer(dir, repo, opts.model);
  const touches = new Map<string, TouchKind[]>();
  const errors = new Map<string, string[]>();
  const touch = (ref: string, kind: TouchKind) => touches.set(ref, [...(touches.get(ref) ?? []), kind]);
  const err = (ref: string, e: string | undefined) => { if (e) errors.set(ref, [...(errors.get(ref) ?? []), e]); };
  const outside: Outside[] = [];
  try {
    // The model the run is meant to have must answer, or every step would quietly go without it.
    const ai = (await api.send<{ providers: Array<{ id: string; state: string }> }>('GET', '/api/ai')).json;
    const claude = ai.providers?.find((p) => p.id === 'claude-cli')?.state;
    if (claude !== 'ready') throw new Error(`the claude CLI is ${claude ?? 'unknown'} here (${opts.model}): nothing run`);
    begin('drop');
    const d = await drop(api, dir, key, providerOf, say);
    await rest(api, say);
    begin('run-1');
    await inboxRun(api, say);

    // Where the app left each payment, and round one.
    const s1 = await stateOf(api, ws);
    const owner = ownerAccountNumber(ws);
    const saleChoice = (entries: readonly JournalEntry[]) => {
      const sale = entries.map((e) => (e.vatCode ? vat().codes.parse(e.vatCode) : null)).find((c) => c?.revenueZiffer);
      return !sale ? 'notSale' : sale.rate > 0 ? 'saleDomestic' : 'saleAbroad';
    };
    const ctxOf = (s: State): Context => ({ hasReceipt: (id) => s.books.receipts.some((r) => r.id === id), owner, saleChoice });
    const first = new Map<string, CaseView>();
    // A bank statement's PDF the real books also keep as a receipt (a card line's proof): dropped, the app reads it
    // as the statement it is and holds it once, so a link to it as a receipt is not asked of the replay.
    const asStatement = new Set(Object.entries(key.receipts).filter(([id, r]) => r.kind === 'statement' && !s1.books.receipts.some((x) => x.id === id)).map(([id]) => id));
    const sideOf = (c: { tx: BankTransaction; entries: JournalEntry[]; receipts: string[] }): KeySide => ({ tx: c.tx, entries: c.entries, receipts: c.receipts.filter((r) => !asStatement.has(r)) });
    // How the comparison reads the books at one moment: codes as the return sees them, and the lines of refs of no
    // payment (a payment's line may lie there); for the movements and other refs, of refs the key does not name.
    const codeKey = returnCodeKey(key.period, key.from);
    const effect = effectJudge(key.period);
    const keyRefs = new Set([...key.other.map((o) => o.ref), ...key.manual.map((m) => m.ref)]);
    const keyElsewhere = () => poolOf([...key.other, ...key.manual].flatMap((o) => o.entries), () => false, key.from, key.to, codeKey);
    const casesAt = (s: State): CompareOptions => {
      const paid = new Set(s.books.transactions.map((t) => t.ref));
      return { codeKey, effect, appElsewhere: poolOf(s.books.journalEntries, (ref) => paid.has(ref), key.from, key.to, codeKey), keyElsewhere: keyElsewhere() };
    };
    const othersAt = (s: State, own: ReadonlySet<string>): CompareOptions => {
      const paid = new Set(s.books.transactions.map((t) => t.ref));
      return { codeKey, effect, appElsewhere: poolOf(s.books.journalEntries, (ref) => paid.has(ref) || keyRefs.has(ref) || own.has(ref), key.from, key.to, codeKey) };
    };

    begin('oracle-1');
    for (const c of key.cases) {
      const ref = refIn(s1.books, c.tx);
      const view = viewOf(s1, ref);
      first.set(c.ref, view);
      if (!ref) { err(c.ref, 'not in the copy: no statement brought it'); continue; }
      for (const a of planFirst(view, sideOf(c), ctxOf(s1))) { touch(c.ref, touchOf(a, view, view, ctxOf(s1))); err(c.ref, await perform(api, ref, a)); }
    }
    // The movements a person entered by hand: entered now, with their receipts, for the next run to book.
    const manualRef = new Map<string, string>();
    const bookedElsewhere = othersAt(s1, new Set()).appElsewhere!;
    for (const m of key.manual) {
      // A movement whose booking the app made already under a ref of its own (a provider's bill's input tax): not entered twice.
      if (m.entries.length && compare({ entries: [], receipts: [] }, { entries: m.entries, receipts: [] }, { codeKey, effect, appElsewhere: bookedElsewhere }).lines) {
        outside.push({ ref: m.ref, kind: 'manual', did: 'booked by the app under its own ref' });
        continue;
      }
      const bank = ws.bankAccounts.find((b) => b.bank === m.tx.bank);
      const r = await api.send<{ ok?: boolean; ref?: string }>('POST', '/api/transactions/manual', {
        date: m.tx.date, description: m.tx.description, amount: m.tx.amount, direction: m.tx.direction, currency: m.tx.currency, ...(bank && bank.role !== 'owner' ? { account: bank.account } : {}),
      });
      if (!r.json.ref) { outside.push({ ref: m.ref, kind: 'manual', did: 'entered', error: `${r.status} ${JSON.stringify(r.json).slice(0, 200)}` }); continue; }
      manualRef.set(m.ref, r.json.ref);
      outside.push({ ref: m.ref, kind: 'manual', did: 'entered' });
      for (const receiptId of m.receipts) {
        if (!s1.books.receipts.some((x) => x.id === receiptId)) continue;
        const e = await perform(api, r.json.ref, { kind: 'link', add: [receiptId], remove: [] });
        if (e) outside.push({ ref: m.ref, kind: 'manual', did: 'link', error: e });
      }
    }
    for (const a of key.vatAdjustments) {
      const { id: _id, ...body } = a;
      const r = await api.send('POST', '/api/vat-adjustments', body);
      outside.push({ ref: a.id, kind: 'vatAdjustment', did: 'entered', ...(r.status >= 400 ? { error: `${r.status} ${JSON.stringify(r.json).slice(0, 200)}` } : {}) });
    }
    await rest(api, say);

    begin('run-2');
    await inboxRun(api, say);

    begin('oracle-2');
    const s2 = await stateOf(api, ws);
    const opts2 = casesAt(s2);
    for (const c of key.cases) {
      const ref = refIn(s2.books, c.tx);
      if (!ref) continue;
      const view = viewOf(s2, ref);
      for (const a of planSecond(view, sideOf(c), ctxOf(s2), opts2)) { touch(c.ref, touchOf(a, first.get(c.ref)!, view, ctxOf(s2))); err(c.ref, await perform(api, ref, a)); }
    }
    for (const m of key.manual) {
      const ref = manualRef.get(m.ref);
      if (!ref) continue;
      const view = viewOf(s2, ref);
      for (const a of planSecond(view, { tx: m.tx, entries: m.entries, receipts: m.receipts }, ctxOf(s2))) {
        const e = await perform(api, ref, a);
        outside.push({ ref: m.ref, kind: 'manual', did: a.kind === 'book' ? (view.entries.length ? 'correction' : 'hand') : a.kind, ...(e ? { error: e } : {}) });
      }
    }
    // Entries without a payment: a provider report's (the app books them from the dropped report), a person's by hand.
    // What the app lacks is booked as a person books an entry of no payment: under a ref the app gives it.
    const otherRef = new Map<string, string>();
    const others2 = othersAt(s2, new Set(manualRef.values()));
    for (const o of key.other) {
      const view = viewOf(s2, o.ref);
      if (compare(view, o, others2).lines) continue;
      const e = await perform(api, undefined, { kind: 'book', entries: o.entries, replace: view.entries.map((x) => x.id) }, (r) => otherRef.set(o.ref, r));
      outside.push({ ref: o.ref, kind: o.kind, did: view.entries.length ? 'correction' : 'hand', ...(e ? { error: e } : {}) });
    }
    await rest(api, say);

    // What the books hold at the end.
    const sf = await stateOf(api, ws);
    const opts1 = casesAt(s1);
    const optsF = casesAt(sf);
    const results: CaseResult[] = key.cases.map((c) => {
      const ref = refIn(sf.books, c.tx);
      const { pass, verdict } = passOf(first.get(c.ref)!, sideOf(c), opts1);
      return { ref: c.ref, ...(ref && ref !== c.ref ? { as: ref } : {}), pass, first: verdict, touches: touches.get(c.ref) ?? [], final: compare(viewOf(sf, ref), sideOf(c), optsF), errors: errors.get(c.ref) ?? [] };
    });
    const othersF = othersAt(sf, new Set([...manualRef.values(), ...otherRef.values()]));
    const otherFinal = key.other.map((o) => ({ ref: o.ref, kind: o.kind, ok: compare(viewOf(sf, otherRef.get(o.ref) ?? o.ref), o, othersF).lines }));
    const manualFinal = key.manual.map((m) => ({ ref: m.ref, ok: compare(viewOf(sf, manualRef.get(m.ref)), m, othersF).lines }));
    const figures = vat().figures(sf.books.journalEntries, key.period as never, sf.books.config.vatAdjustments ?? []) as unknown as { ziffern: Record<string, number>; payable: number };
    end();
    const result = score({
      key, marker, model: opts.model, results, phases, ledger: ledgerRows(ws), figures, intake: d.touches, outside, otherFinal, manualFinal, dropRows: d.rows,
      wallMs: Date.now() - started, touchKinds: TOUCH_KINDS,
    });
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 1) + '\n');
    writeFileSync(join(dir, 'summary.md'), summaryMarkdown(result));
    say(`\n${summaryMarkdown(result)}`);
  } finally {
    end();
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'replay.log'), log.join('\n') + '\n');
    await stop();
  }
}
