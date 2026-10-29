/**
 * Parity of the per-bank statement PDF readers and the statement PDFs' tables (#243), over the
 * statement PDFs of the workspace VANILLA_WORKSPACE names. The model's reads are kept in
 * <out-dir>/reads/ by the file's hash, so a second run asks nothing; the per-file report goes to
 * <out-dir>/parity.json. Keep both out of the repo when the workspace is a real company's.
 *
 *   VANILLA_WORKSPACE=<ws> npx tsx tools/statement-parity/compare.ts <out-dir> [--no-ask] [--seed]
 *
 * `--no-ask` reads nothing new (cached reads only). `--seed` writes each cached read beside its PDF
 * as the app keeps it (`<name>.read.json`), so `npm run extract` on that workspace takes them: run it
 * on a copy only. Prints counts only. The model is the one the app resolves for `statement-read`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readStatementFiles, readTransactions } from '../../src/books/bank-import.js';
import { keptPdfs, writeBeside, type KeptRead } from '../../src/books/pdf-reads.js';
import { parseReadStatement } from '../../src/books/statement-check.js';
import { readStatementPdf } from '../../src/intake/statement-read.js';
import { ask, resolveStep } from '../../src/llm/ask.js';
import { pdfText } from '../../src/parsers/pdf-text.js';
import { extractStatementBalances } from '../../src/providers/statement-pdf/statement-pdf-balances.js';
import { wiseReferences } from '../../src/providers/wise-pdf/wise-statement-pdf.js';
import type { ReadStatement } from '../../src/types/statement-read.js';
import { openWorkspace, partDirs } from '../../src/workspace/workspace.js';
import { fileParity, summarize, type FileParity } from './parity.js';

const [outDir, ...flags] = process.argv.slice(2);
if (!outDir) { console.error('usage: compare.ts <out-dir> [--no-ask] [--seed]'); process.exit(2); }
const noAsk = flags.includes('--no-ask');
const seed = flags.includes('--seed');

const ws = openWorkspace();
const readsDir = join(outDir, 'reads');
mkdirSync(readsDir, { recursive: true });

const pdfs = keptPdfs(ws, readStatementFiles(ws).statements);
const { transactions: exported } = readTransactions(ws);
const { balances } = await extractStatementBalances(partDirs(ws.paths, 'statements'), ws.bankAccounts);
const wiseBanks = new Set(ws.bankAccounts.filter((a) => a.statements === 'wise').map((a) => a.bank));
const resolved = noAsk ? undefined : await resolveStep('statement-read');
console.log(`${pdfs.length} statement PDFs; model ${resolved ? `${resolved.provider.id}/${resolved.model}` : 'not asked (cached reads only)'}`);

let asked = 0;
async function modelRead(path: string): Promise<ReadStatement | undefined> {
  const cache = join(readsDir, `${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 24)}.json`);
  if (existsSync(cache)) return parseReadStatement((JSON.parse(readFileSync(cache, 'utf8')) as { statement?: unknown }).statement);
  if (noAsk) return undefined;
  asked++;
  const started = Date.now();
  const read = await readStatementPdf(path, ask);
  console.log(`  read ${read.by}${read.why ? ` (${read.why})` : ''} in ${Math.round((Date.now() - started) / 1000)} s`);
  if (read.by !== 'model') return undefined;
  writeFileSync(cache, JSON.stringify({ statement: read.statement, by: read.by }));
  return read.statement;
}

const results: FileParity[] = [];
for (const p of pdfs) {
  const references = wiseBanks.has(p.account.bank) ? wiseReferences(await pdfText(p.path, 'raw')) : new Map<string, string>();
  const balance = balances.find((b) => b.sourceFile === basename(p.path));
  const statement = await modelRead(p.path);
  if (statement && seed) writeBeside(p.path, { by: 'model', statement });
  const kept: KeptRead | undefined = statement && statement.currency === p.account.currency ? { file: basename(p.path), account: p.account, statement, by: 'model' } : undefined;
  const result = fileParity(p.file, { balance, references }, kept, exported);
  results.push(result);
  console.log(`  ${results.length}/${pdfs.length} balance ${result.balance}, references ${JSON.stringify(result.references)}, originals ${JSON.stringify(result.originals)}, left out ${result.ambiguous} ambiguous / ${result.unmatched} unmatched`);
}

writeFileSync(join(outDir, 'parity.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ ...summarize(results), askedNow: asked }, null, 2));
