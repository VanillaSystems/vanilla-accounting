/**
 * Parity of the per-bank statement PDF readers and the model's read (#243), over the statement PDFs
 * of the workspace VANILLA_WORKSPACE names. Read-only on the workspace: the model's reads are kept
 * in <out-dir>/reads/ (by the file's hash, so a second run asks nothing) and the per-file report in
 * <out-dir>/parity.json; keep both out of the repo when the workspace is a real company's.
 *
 *   VANILLA_WORKSPACE=<ws> npx tsx tools/statement-parity/compare.ts <out-dir> [--no-ask]
 *
 * PARITY_ONLY=<regex> limits the run to the PDFs whose name under bank-statements/ it matches (a sample).
 * Prints counts only. The model is the one the app resolves for the step `statement-read`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readTransactions } from '../../src/books/bank-import.js';
import { checkStatement } from '../../src/books/statement-check.js';
import { accountOfRead, readStatementPdf } from '../../src/intake/statement-read.js';
import { ask, resolveStep } from '../../src/llm/ask.js';
import { pdfText } from '../../src/parsers/pdf-text.js';
import { extractStatementBalances } from '../../src/providers/statement-pdf/statement-pdf-balances.js';
import { wiseReferences } from '../../src/providers/wise-pdf/wise-statement-pdf.js';
import type { ReadStatement } from '../../src/types/statement-read.js';
import { filesOfPart, openWorkspace, partDirs } from '../../src/workspace/workspace.js';
import { fileParity, summarize, type FileParity } from './parity.js';

const [outDir, ...flags] = process.argv.slice(2);
if (!outDir) { console.error('usage: compare.ts <out-dir> [--no-ask]'); process.exit(2); }
const only = process.env.PARITY_ONLY ? new RegExp(process.env.PARITY_ONLY) : undefined;
const noAsk = flags.includes('--no-ask');

const ws = openWorkspace();
const readsDir = join(outDir, 'reads');
mkdirSync(readsDir, { recursive: true });

const pdfs = filesOfPart(ws.paths, 'statements').filter(([name]) => name.toLowerCase().endsWith('.pdf') && (!only || only.test(name)));
const { transactions: exported } = readTransactions(ws);
const { balances } = await extractStatementBalances(partDirs(ws.paths, 'statements'), ws.bankAccounts);
const wiseBanks = new Set(ws.bankAccounts.filter((a) => a.statements === 'wise').map((a) => a.bank));
const resolved = noAsk ? undefined : await resolveStep('statement-read');
console.log(`${pdfs.length} statement PDFs; model ${resolved ? `${resolved.provider.id}/${resolved.model}` : 'not asked (cached reads only)'}`);

async function modelRead(path: string): Promise<{ statement: ReadStatement; by: string } | undefined> {
  const cache = join(readsDir, `${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 24)}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  if (noAsk) return undefined;
  const started = Date.now();
  let raw = '';
  const read = await readStatementPdf(path, async (prompt, opts) => (raw = await ask(prompt, opts)));
  console.log(`  read ${read.by}${read.why ? ` (${read.why})` : ''} in ${Math.round((Date.now() - started) / 1000)} s`);
  if (read.by !== 'model') { writeFileSync(cache.replace(/\.json$/, '.failed.txt'), raw); return undefined; }
  writeFileSync(cache, JSON.stringify({ statement: read.statement, by: read.by }));
  return read;
}

const results: (FileParity & { adds: boolean })[] = [];
for (const [name, path] of pdfs) {
  const references = wiseBanks.has(basename(dirname(path))) ? wiseReferences(await pdfText(path, 'raw')) : new Map<string, string>();
  const balance = balances.find((b) => b.sourceFile === basename(path));
  const read = await modelRead(path);
  // The account by the read's IBAN or currency, else as the folder and name place the PDF (the readers' answer).
  const account = read ? accountOfRead(read.statement, ws.bankAccounts) ?? ws.bankAccounts.find((a) => a.account === balance?.account) : undefined;
  const result = fileParity(name, { balance, references }, read && account ? { statement: read.statement, account } : undefined, exported);
  results.push({ ...result, adds: read ? checkStatement(read.statement).ok : false });
  console.log(`  ${results.length}/${pdfs.length} balance ${result.balance}, references ${JSON.stringify(result.references)}, originals ${JSON.stringify(result.originals)}`);
}

writeFileSync(join(outDir, 'parity.json'), JSON.stringify(results, null, 2));
const s = summarize(results);
console.log(JSON.stringify({ ...s, readsThatAddUp: results.filter((r) => r.adds).length }, null, 2));
