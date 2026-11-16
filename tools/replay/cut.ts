/**
 * The clean slate of a replay (README.md «The copy»): a copy of a workspace's books as they stood at
 * the eve of the replayed period, the period's raw inputs beside it, and its answer key.
 *
 * What counts as «after the cut» (as the books know it, line for line; a kept line is written back
 * byte for byte, so the seals of the filed periods hold):
 * - a payment dated after the cut; its entries, and every entry dated after the cut;
 * - a receipt linked only to such payments (or entries), or linked to none and dated after the cut;
 * - the links of either; statements whose period starts after the cut and balances dated after it;
 * - the run log, the period's questions, VAT adjustments of later periods, and correction cases
 *   whose correcting entries go.
 *
 * The inputs are what a person drops: the statement files whose days reach past the cut, and the
 * receipts set aside that belong to the period (linked to one of its payments or entries, or
 * unlinked and dated in it), under the name they arrived with. Nothing of the source is written.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BankStatement, BankTransaction, CorrectionCase, JournalEntry, Mapping, Receipt, VatAdjustment } from '../../src/types/index.js';
import { APP_FOLDER, workspaceAt, yearPaths } from '../../src/workspace/workspace.js';
import { addDays, derivePeriod } from '../../src/accounting/periods.js';
import { isReportRef } from '../../src/booking/sales-report.js';
import { isManualRef } from '../../src/books/refs.js';
import { statementDetails } from '../../src/providers/statement-files.js';
import { vat } from '../../src/engines/index.js';
import type { AnswerKey, InputFile, KeyCase, KeyManual, KeyOther } from './key.js';

export type Arm = 'cold' | 'today';
export const ARMS: readonly Arm[] = ['cold', 'today'];

/** The marker a run folder carries: `npm run replay -- run` works only on a folder the cut made. */
export const MARKER = 'replay.json';

export interface Marker {
  period: string;
  arm: Arm;
  source: string;
  madeAt: string;
  /** The copy's workspace folder, relative to the run folder. */
  workspace: string;
}

/** Top-level names of the workspace folder a copy leaves out: this machine's state, mail and its cursors, the answer key's figures. */
const LEFT_OUT = new Set(['data', 'collected', 'sources', 'mail.yaml', 'handover', 'output', 'beleg-import', '.git']);

interface Raw<T> { line: string; v: T }
const readLines = <T>(file: string): Raw<T>[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((line) => ({ line, v: JSON.parse(line) as T })) : []);
const writeLines = (file: string, rows: Raw<unknown>[]) => writeFileSync(file, rows.map((r) => r.line + '\n').join(''));

const isManualTx = (t: BankTransaction) => t.source === 'manual' || isManualRef(t.ref);

/** The parts of the source's books the cut decides on, read from its year folder. */
export interface SourceBooks {
  transactions: BankTransaction[];
  entries: JournalEntry[];
  mappings: Mapping[];
  receipts: Receipt[];
  statements: BankStatement[];
}

/** What the cut keeps and what it sets aside, decided on the records alone (no file is touched): tests/replay.test.ts holds it. */
export function decideCut(books: SourceBooks, from: string, to: string) {
  const cut = addDays(from, -1);
  const txDate = new Map(books.transactions.map((t) => [t.ref, t.date]));
  const outTx = new Set(books.transactions.filter((t) => t.date > cut).map((t) => t.ref));
  const outEntry = (e: JournalEntry) => e.date > cut || outTx.has(e.transactionRef);
  const entryDates = new Map<string, string>();
  for (const e of books.entries) if (!txDate.has(e.transactionRef)) entryDates.set(e.transactionRef, [entryDates.get(e.transactionRef), e.date].filter(Boolean).sort()[0]!);
  const refDate = (ref: string) => txDate.get(ref) ?? entryDates.get(ref);
  // A payment booked by hand has no bank transaction: its ref lives only on its entries.
  const outRef = new Set([...outTx, ...books.entries.filter((e) => outEntry(e) && !txDate.has(e.transactionRef)).map((e) => e.transactionRef)]);
  const linked = new Map<string, Set<string>>();
  for (const m of books.mappings) (linked.get(m.receiptId) ?? linked.set(m.receiptId, new Set()).get(m.receiptId)!).add(m.transactionRef);
  const dayOf = (r: Receipt) => r.date || r.indexedAt?.slice(0, 10) || '';
  const receiptOut = (r: Receipt) => {
    const dates = [...(linked.get(r.id) ?? [])].map(refDate).filter((d): d is string => !!d);
    return dates.length ? dates.every((d) => d > cut) : dayOf(r) > cut;
  };
  const outReceipts = new Set(books.receipts.filter(receiptOut).map((r) => r.id));
  // The period's receipts: linked to one of its payments or entries, or unlinked and dated in it.
  const inPeriod = (d: string | undefined) => !!d && d >= from && d <= to;
  const inputReceipts = books.receipts.filter((r) => outReceipts.has(r.id)
    && ([...(linked.get(r.id) ?? [])].some((ref) => inPeriod(refDate(ref))) || (!(linked.get(r.id)?.size) && dayOf(r) <= to)));
  return {
    cut, outTx, outRef, outReceipts, inputReceipts,
    keepEntry: (e: JournalEntry) => !outEntry(e),
    keepMapping: (m: Mapping) => !outRef.has(m.transactionRef) && !outReceipts.has(m.receiptId),
    keepStatement: (s: BankStatement) => s.fromDate <= cut,
    refDate,
  };
}

/** The answer key's payments, hand movements and other entries of the period. */
export function keyOf(books: SourceBooks, from: string, to: string): Pick<AnswerKey, 'cases' | 'manual' | 'other' | 'correctionsOfFiled'> {
  const inPeriod = (d: string) => d >= from && d <= to;
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.entries) (byRef.get(e.transactionRef) ?? byRef.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
  const receiptsOf = (ref: string) => [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))].sort();
  // One payment per ref: a card charge split over several currency accounts is one movement in each, under one ref.
  const periodTx = [...new Map(books.transactions.filter((t) => inPeriod(t.date)).map((t) => [t.ref, t])).values()];
  const cases: KeyCase[] = periodTx.filter((t) => !isManualTx(t)).map((tx) => ({ ref: tx.ref, tx, entries: byRef.get(tx.ref) ?? [], receipts: receiptsOf(tx.ref) }));
  const manual: KeyManual[] = periodTx.filter(isManualTx).map((tx) => ({ ref: tx.ref, tx, entries: (byRef.get(tx.ref) ?? []).filter((e) => !e.corrects), receipts: receiptsOf(tx.ref) }));
  const txRefs = new Set(books.transactions.map((t) => t.ref));
  const others = books.entries.filter((e) => inPeriod(e.date) && !txRefs.has(e.transactionRef) && !e.corrects);
  const other: KeyOther[] = [...new Set(others.map((e) => e.transactionRef))].map((ref) => ({
    ref, entries: others.filter((e) => e.transactionRef === ref), receipts: receiptsOf(ref), kind: isReportRef(ref) ? 'report' : 'hand',
  }));
  // Corrections of filed periods dated in this one, on no payment of it: their own 0535, not this return.
  const caseRefs = new Set(periodTx.map((t) => t.ref));
  const correctionsOfFiled = books.entries.filter((e) => inPeriod(e.date) && e.corrects && !caseRefs.has(e.transactionRef)).length;
  return { cases, manual, other, correctionsOfFiled };
}

/** A name not taken yet in `taken`: «x (1).pdf» after «x.pdf». */
function freeName(name: string, taken: Set<string>): string {
  let out = name;
  for (let n = 1; taken.has(out.toLowerCase()); n++) out = `${basename(name, extname(name))} (${n})${extname(name)}`;
  taken.add(out.toLowerCase());
  return out;
}

/**
 * Makes the run folder `out`: repo/<APP_FOLDER>/ (the copy, a git repository of its own), inputs/,
 * key.json and the marker. Refuses a folder that exists or lies inside `source`.
 */
export function prepare(opts: { source: string; period: string; arm: Arm; out: string }): { marker: Marker; key: AnswerKey } {
  const period = derivePeriod(opts.period);
  if (!period) throw new Error(`not a period: ${opts.period}`);
  const { from, to } = period;
  const src = workspaceAt(opts.source);
  const out = opts.out;
  if (existsSync(out)) throw new Error(`${out} exists: a replay starts in a new folder`);
  if (!relative(src.paths.repository, out).startsWith('..')) throw new Error(`${out} lies inside the source repository`);
  const year = from.slice(0, 4);
  const ys = yearPaths(src.paths, year);
  const L = <T>(name: string) => readLines<T>(join(ys.books, name));
  const raw = {
    transactions: L<BankTransaction>('transactions.jsonl'), entries: L<JournalEntry>('entries.jsonl'), mappings: L<Mapping>('mappings.jsonl'),
    receipts: L<Receipt>('receipts.jsonl'), statements: L<BankStatement>('statements.jsonl'), balances: L<{ date: string }>('balances.jsonl'),
  };
  const books: SourceBooks = { transactions: raw.transactions.map((r) => r.v), entries: raw.entries.map((r) => r.v), mappings: raw.mappings.map((r) => r.v), receipts: raw.receipts.map((r) => r.v), statements: raw.statements.map((r) => r.v) };
  const d = decideCut(books, from, to);
  const ledger = JSON.parse(readFileSync(src.paths.ledger, 'utf8')) as { config: { closedThrough?: string; vatAdjustments?: VatAdjustment[]; correctionCases?: CorrectionCase[] } };
  const closedThrough = ledger.config.closedThrough ?? '';
  if (closedThrough > d.cut) throw new Error(`${opts.period} is filed (closed through ${closedThrough}): its entries can no longer be cut away`);

  // The answer key, from the books as they are.
  const filingKey = opts.period;
  const figures = vat().figures(books.entries, filingKey as never, ledger.config.vatAdjustments ?? []) as unknown as { payable: number; ziffern: Record<string, number> };

  // The copy.
  const repo = join(out, 'repo');
  const ws = join(repo, APP_FOLDER);
  mkdirSync(ws, { recursive: true });
  // The repository's ignore list: what the app keeps local (data/) stays out of the copy's commits too.
  if (src.paths.repository !== src.paths.root && existsSync(join(src.paths.repository, '.gitignore'))) cpSync(join(src.paths.repository, '.gitignore'), join(repo, '.gitignore'));
  for (const name of readdirSync(src.paths.root)) {
    if (LEFT_OUT.has(name) || (name === 'knowledge' && opts.arm === 'cold')) continue;
    cpSync(join(src.paths.root, name), join(ws, name), { recursive: true });
  }
  if (opts.arm === 'cold') mkdirSync(join(ws, 'knowledge'), { recursive: true });
  const cy = yearPaths({ transactional: join(ws, 'transactional-data') }, year);
  rmSync(cy.expected, { recursive: true, force: true });
  // Later years go whole.
  for (const y of existsSync(join(ws, 'transactional-data')) ? readdirSync(join(ws, 'transactional-data')) : []) if (/^\d{4}$/.test(y) && y > year) rmSync(join(ws, 'transactional-data', y), { recursive: true, force: true });
  writeLines(join(cy.books, 'transactions.jsonl'), raw.transactions.filter((r) => !d.outTx.has(r.v.ref)));
  writeLines(join(cy.books, 'entries.jsonl'), raw.entries.filter((r) => d.keepEntry(r.v)));
  writeLines(join(cy.books, 'mappings.jsonl'), raw.mappings.filter((r) => d.keepMapping(r.v)));
  writeLines(join(cy.books, 'receipts.jsonl'), raw.receipts.filter((r) => !d.outReceipts.has(r.v.id)));
  writeLines(join(cy.books, 'statements.jsonl'), raw.statements.filter((r) => d.keepStatement(r.v)));
  writeLines(join(cy.books, 'balances.jsonl'), raw.balances.filter((r) => r.v.date <= d.cut));
  if (existsSync(cy.runLog)) writeFileSync(cy.runLog, '');
  if (existsSync(cy.questions)) writeLines(cy.questions, readLines<{ at: string }>(cy.questions).filter((r) => r.v.at.slice(0, 10) <= d.cut));
  const keptEntries = new Set(raw.entries.filter((r) => d.keepEntry(r.v)).map((r) => r.v.id));
  ledger.config.vatAdjustments = (ledger.config.vatAdjustments ?? []).filter((a) => a.period < filingKey);
  ledger.config.correctionCases = (ledger.config.correctionCases ?? []).filter((c) => c.correctionEntryIds.every((id) => keptEntries.has(id)));
  if (!ledger.config.correctionCases.length) delete ledger.config.correctionCases;
  writeFileSync(join(ws, 'ledger.json'), JSON.stringify(ledger, null, 2) + '\n');

  // The inputs: receipts out of the copy, the period's into inputs/.
  const inputs: InputFile[] = [];
  const taken = new Set<string>();
  const receiptNames: AnswerKey['receipts'] = {};
  for (const r of books.receipts) {
    if (!d.outReceipts.has(r.id)) continue;
    const inCopy = join(cy.receipts, r.filename);
    const file = join(ys.receipts, r.filename);
    if (d.inputReceipts.includes(r) && existsSync(file)) {
      const name = freeName(r.originalFilename || basename(r.filename), taken);
      const path = join('inputs', 'receipts', name);
      mkdirSync(join(out, 'inputs', 'receipts'), { recursive: true });
      cpSync(file, join(out, path));
      inputs.push({ path, name, kind: 'receipt', id: r.id });
      receiptNames[r.id] = { name, ...(r.kind ? { kind: r.kind } : {}) };
    }
    rmSync(inCopy, { force: true });
  }
  // The statements: a file whose days reach past the cut goes to the inputs (a bank export spanning the cut too: its known days are skipped on import).
  const recordOf = new Map(books.statements.map((s) => [`${s.bank}/${s.filename}`, s]));
  for (const bank of existsSync(ys.statements) ? readdirSync(ys.statements) : []) {
    if (!statSync(join(ys.statements, bank)).isDirectory()) continue;
    for (const f of readdirSync(join(ys.statements, bank))) {
      const file = join(ys.statements, bank, f);
      const rec = recordOf.get(`${bank}/${f}`);
      const details = rec ? undefined : statementDetails(readFileSync(file), f);
      const span = rec ? { first: rec.fromDate, last: addDays(rec.toDate, rec.toDate > rec.fromDate ? -1 : 0) } : details?.booked;
      if (!span || span.last <= d.cut) continue;
      if (span.first <= to) {
        const path = join('inputs', 'statements', bank, f);
        mkdirSync(join(out, 'inputs', 'statements', bank), { recursive: true });
        cpSync(file, join(out, path));
        inputs.push({ path, name: f, kind: 'statement', bank });
      }
      if (rec || span.first > d.cut) rmSync(join(cy.statements, bank, f), { force: true });
    }
  }

  const key: AnswerKey = {
    period: filingKey, from, to, cut: d.cut,
    ...keyOf(books, from, to),
    vatAdjustments: (JSON.parse(readFileSync(src.paths.ledger, 'utf8')).config.vatAdjustments ?? []).filter((a: VatAdjustment) => a.period === filingKey),
    receipts: receiptNames,
    figures: { ziffern: figures.ziffern, payable: figures.payable, filed: closedThrough >= to },
    inputs,
  };
  writeFileSync(join(out, 'key.json'), JSON.stringify(key, null, 1) + '\n');
  const marker: Marker = { period: filingKey, arm: opts.arm, source: src.paths.root, madeAt: new Date().toISOString(), workspace: relative(out, ws) };
  writeFileSync(join(out, MARKER), JSON.stringify(marker, null, 2) + '\n');
  // A repository of its own, so what the app commits stays in the copy.
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=Replay', '-c', 'user.email=replay@localhost', 'commit', '-q', '-m', `Replay of ${filingKey} (${opts.arm}): the books cut at ${d.cut}`);
  return { marker, key };
}
