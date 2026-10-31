import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { yearPaths, yearsOf, type WorkspacePaths } from '../workspace/workspace.js';
import { homeOf, type Books } from './store.js';

/**
 * The files beside the books that name movements by ref: the invoices' payment allocations, each
 * year's questions and run log, and the AI sidebar's conversations, whose changes keep an undo by ref.
 */
function besideBooks(paths: WorkspacePaths): string[] {
  const conversations = join(paths.data, 'assistant');
  return [
    paths.invoices,
    ...yearsOf(paths).flatMap((y) => [yearPaths(paths, y).questions, yearPaths(paths, y).runLog]),
    ...(existsSync(conversations) ? readdirSync(conversations).filter((f) => f.endsWith('.json')).map((f) => join(conversations, f)) : []),
  ].filter((f) => existsSync(f));
}

/** A receipt's read text is the vendor's words: a number in it names no movement of the books. */
const booksText = (books: Books): string => JSON.stringify(books, (key, value: unknown) => (key === 'extractedText' ? undefined : value));

/**
 * The next free M<year>-NNN, the ref of a manual transaction (an Auslage) or of an entry with no
 * transaction behind it (an Eigenverbrauch rebooking, a year-end accrual). A number is taken while
 * anything names it (#124): a record of the books in any field (a transaction, an entry, a mapping,
 * a statement, a replaced booking, a correction's text, a correction case), and, for books
 * loadBooks read, a question, a run log line, an invoice's payment or a change of the AI sidebar.
 * A deleted movement's number so stays taken while something still points at it.
 */
export function nextManualRef(books: Books, year: string): string {
  const home = homeOf(books);
  const texts = [booksText(books), ...(home ? besideBooks(home).map((f) => readFileSync(f, 'utf8')) : [])];
  const named = new RegExp(`\\bM${year}-(\\d{3,})\\b`, 'g');
  let max = 0;
  for (const text of texts) for (const m of text.matchAll(named)) max = Math.max(max, Number(m[1]));
  return `M${year}-${String(max + 1).padStart(3, '0')}`;
}
