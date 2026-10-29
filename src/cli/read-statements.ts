/**
 * npm run read-statements
 *
 * The statement PDFs kept as their month's statement and not read yet (#243): the model reads each,
 * one after the other, N of M, and its answer is kept beside the PDF; then the bank side of the books
 * is merged again, so they take each closing balance and the references and foreign amounts the bank
 * export lacks. Running it is the yes to «N Kontoauszüge von der KI lesen lassen?». Ctrl-C stops: what
 * was read stays read, and the next run goes on from there. Filed months are not read.
 */
import 'dotenv/config';
import { loadBooks, saveBooks, update, PERSON } from '../books/store.js';
import { mergeBankFiles, reconcileWithFiles } from '../books/bank-import.js';
import { differenceAccountOf } from '../books/year-close.js';
import { MAX_READ_PAGES, readKeptPdfs, unreadPdfs } from '../intake/statement-read.js';
import { askIfReady } from '../intake/run.js';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();
const pdfs = unreadPdfs(ws, loadBooks(ws));
if (!pdfs.length) {
  console.log('Every statement PDF of an open month is read.');
  process.exit(0);
}
const ask = await askIfReady();
if (!ask) {
  console.error(`⛔ No AI answers here (Firma › KI): ${pdfs.length} statement PDF(s) stay unread. Their balance and references can be entered by hand on each statement in Kontoauszüge.`);
  process.exit(1);
}
let stop = false;
process.on('SIGINT', () => { stop = true; console.log('\nStopping after this statement…'); });
console.log(`Reading ${pdfs.length} statement PDF(s), one after the other, at most ${MAX_READ_PAGES} pages each.`);
const run = await readKeptPdfs(pdfs, ask, {
  progress: (done, total, file) => { if (file) console.log(`[${done + 1}/${total}] ${file}`); },
  cancelled: () => stop,
  log: (line) => console.log(line),
});
if (run.read) {
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    mergeBankFiles(ws, b);
    reconcileWithFiles(ws, b, differenceAccountOf(ws));
  });
  saveBooks(ws, books);
}
console.log(`\n${run.read} read, ${run.failed.length} not read${run.stopped ? `; stopped: ${run.stopped.error}` : ''}.`);
if (run.failed.length) console.log('A statement not read is asked again on the next run.');
process.exit(run.stopped ? 1 : 0);
