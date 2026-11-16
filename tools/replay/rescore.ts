/**
 * npm run replay -- score <folder>: a finished run judged again by today's comparison, from what the
 * folder kept, with no server and no model call. Writes result-rescored.json and summary-rescored.md.
 *
 * Where the app left each payment is put together again: the entries the app (a rule, its code, a
 * model) wrote in a run that started before the oracle's first round, as they stand or as the oracle's
 * deletions recorded them (data/trash/entries/), and code's entries without a run. A run the store no
 * longer holds (a finished run is not kept) counts as one of the app's own: the payments the oracle
 * opened up were not booked at that point, and the run judged those as asked or open already. A payment the run
 * found asked or open stays so; its links are judged as the run judged them (they are not kept).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry } from '../../src/types/index.js';
import { workspaceAt } from '../../src/workspace/workspace.js';
import { loadBooks } from '../../src/books/store.js';
import { vat } from '../../src/engines/index.js';
import type { AnswerKey } from './key.js';
import { judgeLines, parseLine, settle, showLine, type Verdict } from './compare.js';
import { effectJudge, poolOf, returnCodeKey } from './judge.js';
import { categoriesOf, categoryLines, type Result } from './report.js';
import type { CaseResult } from './drive.js';

type Figures = { ziffern: Record<string, number>; payable: number };

export function rescore(dir: string): void {
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')) as AnswerKey;
  const was = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Result;
  const books = loadBooks(workspaceAt(join(dir, 'repo')));
  const oracleAt = was.phases.find((p) => p.name === 'oracle-1')!.startedAt;
  const runStart = new Map<string, string>();
  const runs = join(dir, 'state', 'runs');
  for (const sub of existsSync(runs) ? readdirSync(runs) : []) {
    for (const f of readdirSync(join(runs, sub)).filter((x) => x.endsWith('.json'))) {
      const r = JSON.parse(readFileSync(join(runs, sub, f), 'utf8')) as { id: string; startedAt: string };
      runStart.set(r.id, r.startedAt);
    }
  }
  const trash = join(dir, 'repo', 'vanilla-accounting', 'data', 'trash', 'entries');
  const deleted = (existsSync(trash) ? readdirSync(trash) : []).map((f) => (JSON.parse(readFileSync(join(trash, f), 'utf8')) as { entry: JournalEntry }).entry);
  // The app's entries as its own runs left them.
  const byApp = (e: JournalEntry) => e.by?.kind !== 'person' && e.by?.kind !== 'assistant' && (!e.run || (runStart.get(e.run) ?? '') < oracleAt);
  const seen = new Set<string>();
  const first = [...books.journalEntries, ...deleted].filter((e) => !seen.has(e.id) && seen.add(e.id) && byApp(e));

  const codeKey = returnCodeKey(key.period, key.from);
  const effect = effectJudge(key.period);
  const paid = new Set(books.transactions.map((t) => t.ref));
  const keyElsewhere = poolOf([...key.other, ...key.manual].flatMap((o) => o.entries), () => false, key.from, key.to, codeKey);
  const appElsewhere = poolOf(first, (ref) => paid.has(ref), key.from, key.to, codeKey);
  const oldBy = new Map(was.cases.list.map((c) => [c.ref, c as CaseResult]));
  // A payment the run found booked: the lines its saved diff names on each side are judged again (the
  // entries themselves may be gone: a run after the oracle's links may have booked the payment anew).
  const results: CaseResult[] = key.cases.map((c) => {
    const old = oldBy.get(c.ref)!;
    if (old.pass !== 'wrong' || !old.first.diff) return old;
    const opts = { codeKey, effect, appElsewhere, keyElsewhere };
    const { appOnly, keyOnly } = settle(old.first.diff.app.map(parseLine), old.first.diff.key.map(parseLine), opts);
    const { lines, wrong } = judgeLines(appOnly, keyOnly, opts);
    const first1: Verdict = {
      lines, links: old.first.links, ok: lines && old.first.links,
      ...(wrong ? { wrong } : {}),
      diff: { app: appOnly.map(showLine), key: keyOnly.map(showLine), linksApp: old.first.diff.linksApp, linksKey: old.first.diff.linksKey },
    };
    return { ...old, first: first1, pass: first1.ok ? 'right' : 'wrong' };
  });

  // The figures: as the run ended, and without the app's entries on refs the key does not know (what the oracle never looked at).
  const known = new Set([...key.cases.map((c) => c.ref), ...key.other.map((o) => o.ref)]);
  const manualMade = new Set(books.transactions.filter((t) => t.source === 'manual' && t.date >= key.from).map((t) => t.ref));
  const unkeyed = books.journalEntries.filter((e) => e.date >= key.from && e.date <= key.to && !e.corrects && !known.has(e.transactionRef) && !manualMade.has(e.transactionRef) && e.by?.kind !== 'person');
  const figures = (es: JournalEntry[]) => vat().figures(es, key.period as never, books.config.vatAdjustments ?? []) as unknown as Figures;
  const diffOf = (f: Figures) => Object.fromEntries([...new Set([...Object.keys(f.ziffern), ...Object.keys(key.figures.ziffern)])].map((z) => [z, Math.round(((f.ziffern[z] ?? 0) - (key.figures.ziffern[z] ?? 0)) * 100) / 100]).filter(([, d]) => d !== 0));
  const atEnd = diffOf(figures(books.journalEntries));
  const withoutUnkeyed = diffOf(figures(books.journalEntries.filter((e) => !unkeyed.includes(e))));

  const categories = categoriesOf(results);
  const untouchedCorrect = results.filter((c) => !c.touches.length && c.first.ok).length;
  const out = {
    period: key.period, arm: was.arm, model: was.model, rescoredAt: new Date().toISOString(),
    categories, untouchedCorrect,
    figures: { atEnd, withoutUnkeyedAppEntries: withoutUnkeyed, unkeyed: unkeyed.map((e) => ({ ref: e.transactionRef, date: e.date, debit: e.accountDebit, credit: e.accountCredit, vat: e.vatCode ?? '', amount: e.amount, by: e.by })) },
    cases: results.map((c) => ({ ref: c.ref, pass: c.pass, first: c.first, touches: c.touches })),
  };
  writeFileSync(join(dir, 'result-rescored.json'), JSON.stringify(out, null, 1) + '\n');
  const md = [
    `# Replay ${key.period}, ${was.arm} arm, model ${was.model}: rescored`,
    '',
    `${results.length} payments. Untouched and correct by today's comparison: ${untouchedCorrect} (the run counted touches as it made them).`,
    '',
    ...categoryLines(categories),
    '## Figures',
    '',
    `At the end of the run, against the key: ${JSON.stringify(atEnd)}.`,
    `Without the app's entries on refs the key does not know (${unkeyed.length} entries on ${new Set(unkeyed.map((e) => e.transactionRef)).size} refs): ${JSON.stringify(withoutUnkeyed)}.`,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'summary-rescored.md'), md);
  console.log(md);
}
