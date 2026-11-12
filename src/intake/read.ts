/**
 * Step 1 of the inbox processing (`npm run extract`): the text of every new PDF in beleg-import/
 * (staged) and receipts/ (archived), with pdf.js and the model's vision as fallback, and the
 * bank side read again from bank-statements/ (src/books/bank-import.ts). Payments carrying an
 * invoice's reference are booked from the invoice (ADR 0010). A statement no bank account of
 * belege.workspace.yaml takes stops the step before anything is written.
 *
 * PNG/JPG files dropped into beleg-import/ are wrapped into a PDF (src/parsers/image-pdf.ts)
 * first; the original image is deleted. iCloud placeholders and files that are no PDF yet are skipped. A
 * file in beleg-import/ with the SHA-256 of a receipt or of another inbox file is removed, with a note.
 */
import { assessmentFacts } from '../booking/customs-invoice.js';
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assignUniqueRefs } from '../providers/camt053/camt053.js';
import { imageToPdf, isImageFile } from '../parsers/image-pdf.js';
import { smallerPdf } from '../parsers/smaller.js';
import { pdfText } from '../parsers/pdf-text.js';
import { detectVatProofIssue, noiseText, textFacts, textProves } from '../parsers/receipt-text.js';
import { filedReceipt, forgetReadFacts } from './vat.js';
import { buildVisionPrompt } from '../llm/prompts.js';
import type { Receipt } from '../types/index.js';
import { filesOfPart, type Workspace } from '../workspace/workspace.js';
import { mergeIndex, readStatementFiles, readTransactions, reconcileWithFiles, withinBooks } from '../books/bank-import.js';
import { keptReads } from '../books/pdf-reads.js';
import { readKeptPdfs, readsByItself, unreadPdfs } from './statement-read.js';
import { differenceAccountOf } from '../books/year-close.js';
import type { BankFiles } from '../books/bank-import.js';
import { loadInvoices, saveInvoices } from '../invoices/store.js';
import { matchPayments, type PaymentOutcome } from '../invoices/payments.js';
import { bookInvoiceEvents } from '../invoices/events.js';
import { fileReceipts, paymentContext } from '../invoices/service.js';
import { stemOf, type Ask, type IntakeNote, type StepRun } from './pipeline.js';
import { putInQuarantine } from './quarantine.js';
import { documentKind } from './document-kind.js';
import { askKind, asksModel, kindOfModel, MODEL_RULE, MODEL_TEXT, NOT_A_RECEIPT, visionVerdict, type ModelKind } from './unclear.js';
import { statementFacts } from '../books/statement-facts.js';
import { documents } from '../engines/index.js';

// ─── The PDF's own text, fallback to the model's vision for OCR ─────────────

/**
 * `pdftotext` names the method of a digital PDF's own text, as the books have recorded it since the first extraction.
 * `verdict`: a file new to the books, whose reading may set it aside as no receipt (#361); its «Kein Beleg: …» comes
 * back as `verdict`, never as text. A file the books hold is only read: a verdict there is ignored, and no text is kept.
 */
async function extractTextFast(
  pdfPath: string,
  ask: Ask | undefined,
  log: (line: string) => void,
  verdict = false,
): Promise<{ text: string; method: 'pdftotext' | 'claude-vision'; vision?: 'none'; verdict?: ModelKind }> {
  try {
    const text = (await pdfText(pdfPath)).trim();
    if (text.length > 30) {
      return { text, method: 'pdftotext' };
    }
  } catch {}

  if (!ask) return { text: '', method: 'claude-vision', vision: 'none' };
  // Fallback: vision OCR on scanned PDFs. The lean call runs from an empty
  // directory, so the Read tool gets the absolute path and that one folder.
  const absPath = resolve(pdfPath);
  try {
    const text = await ask(
      buildVisionPrompt(absPath, { verdict }),
      { step: 'receipt-vision', timeoutMs: 120_000, attachments: [absPath] },
    );
    const said = visionVerdict(text);
    if (said && !verdict) log(`  ${pdfPath}: the reading said «${NOT_A_RECEIPT}» of a file the books hold: ignored, no text kept`);
    return said ? { text: '', method: 'claude-vision', ...(verdict ? { verdict: said } : {}) } : { text, method: 'claude-vision' };
  } catch (e: any) {
    log(`  claude -p failed: ${e.message?.substring(0, 100)}`);
    return { text: '', method: 'claude-vision' };
  }
}

/**
 * A receipt whose text proves nothing and that no model has read yet: an old local OCR's noise off a
 * phone photo (#284). The model reads it again, once. A receipt of a filed quarter keeps its text:
 * its VAT was declared as booked.
 */
export const readsAgain = (books: Parameters<typeof filedReceipt>[0], r: Receipt): boolean =>
  !!r.extractedText && noiseText(r) && !filedReceipt(books, r);

// ─── Concurrency pool ───────────────────────────────────────────────────────

function createPool(concurrency: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    while (running >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      if (queue.length > 0) queue.shift()!();
    }
  };
}

// ─── PDF scanning helpers ────────────────────────────────────────────────────

interface FoundFile {
  filename: string;
  filepath: string;
  location: 'staged' | 'archived';
}

/**
 * Wraps any PNG/JPG/HEIC images in a directory into PDFs, then removes the originals so they aren't
 * picked up as duplicates by scanPdfs. Returns each conversion by the names before and after.
 */
async function convertImagesToPdf(dir: string, log: (line: string) => void, theirs?: ReadonlySet<string>): Promise<Array<{ from: string; to: string }>> {
  const done: Array<{ from: string; to: string }> = [];
  if (!existsSync(dir)) return done;
  for (const f of readdirSync(dir).filter((f) => isImageFile(f) && !theirs?.has(stemOf(f)))) {
    const imgPath = join(dir, f);
    const pdfPath = imgPath.replace(/\.[^.]+$/, '.pdf');
    if (existsSync(pdfPath)) {
      log(`  skip convert (target exists): ${f}`);
      continue;
    }
    try {
      // A photo is an own capture: made smaller before it gets its id.
      writeFileSync(pdfPath, await smallerPdf(await imageToPdf(readFileSync(imgPath), f)));
      unlinkSync(imgPath);
      done.push({ from: f, to: basename(pdfPath) });
      log(`  converted ${f} -> ${basename(pdfPath)}`);
    } catch (e: any) {
      log(`  convert failed for ${f}: ${e.message?.substring(0, 100)}`);
    }
  }
  return done;
}

/**
 * The .pdf files of the inbox that are no PDF inside (a download cut short, a file named .pdf by
 * hand): no step will ever read them, so they go to quarantine with the reason (r8k-9). An empty
 * file may still be being written and stays; an iCloud placeholder is no file yet.
 */
function unreadablePdfs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf') && !f.endsWith('.icloud') && statSync(join(dir, f)).size > 0 && !isPdf(join(dir, f))).sort();
}

function isPdf(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(5);
    return readSync(fd, head, 0, 5, 0) === 5 && head.toString('latin1') === '%PDF-';
  } finally {
    closeSync(fd);
  }
}

const isReceiptPdf = (name: string, path: string) =>
  name.toLowerCase().endsWith('.pdf') && !name.endsWith('.icloud') && isPdf(path); // An iCloud placeholder or a file still being written is no PDF yet; a small PDF is one.

function scanPdfs(dir: string, location: 'staged' | 'archived'): FoundFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => isReceiptPdf(f, join(dir, f)))
    .sort()
    .map((f) => ({ filename: f, filepath: join(dir, f), location }));
}

/** The receipts of every year folder, by name. */
const archivedPdfs = (ws: Workspace): FoundFile[] => filesOfPart(ws.paths, 'receipts')
  .filter(([name, path]) => !name.includes('/') && isReceiptPdf(name, path))
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([filename, filepath]) => ({ filename, filepath, location: 'archived' as const }));

const idOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex').substring(0, 16);

/** The camt053 files that belong to no bank account, as `bank-statements/<file>: <problem>`. */
function unmatchedOf(bank: BankFiles): string[] {
  return bank.files.flatMap((f) => (f.status === 'unmatched' ? [`bank-statements/${f.file}: ${f.problem}`] : []));
}

interface Extracted { text: string; method: Receipt['extractionMethod']; fileSize: number; verdict?: ModelKind }

/**
 * What a fresh receipt's text says it is (src/intake/document-kind.ts): an order confirmation or a
 * delivery note is kept beside its invoice, never paid on its own. That a text is no receipt at all
 * decides only for what the model read (a photo): a PDF's own text was judged at the drop already,
 * where the person can say «doch ein Beleg». What the words leave unclear, the model's «no receipt»
 * sets aside when there is one (src/intake/unclear.ts). A bank statement (#151) is dated on its period's last day.
 */
function kindOfText(fresh: Extracted, filename: string, originalFilename: string, model?: ModelKind): Pick<Receipt, 'kind' | 'kindBy' | 'kindRule' | 'kindWhy' | 'date' | 'amount' | 'currency'> {
  const statement = statementFacts({ extractedText: fresh.text, filename, originalFilename }, documents());
  if (statement) return { kind: 'statement', kindBy: 'rule', kindRule: 'document:statement', ...(statement.to ? { date: statement.to } : {}) };
  const v = documentKind(fresh.text, documents());
  // A customs assessment keeps its tax and day: a payment to the customs office is paired with it by them (#197).
  if (v.is === 'supporting') return { kind: 'supporting', kindBy: 'rule', kindRule: `document:${v.why}`, ...(v.why === 'customs-assessment' ? assessmentFacts(fresh.text, documents().customs) : {}) };
  if (v.is === 'other' && fresh.method === 'claude-vision') return { kind: 'noise', kindBy: 'rule', kindRule: `document:${v.why}` };
  // What code did not recognise, the model's word decides: its reading said the picture shows no receipt at all
  // (a holiday photo, #361), or, asked about the text, «none».
  if (v.is !== 'unclear') return {};
  const said = fresh.verdict ?? model;
  return said ? kindOfModel(said) : {};
}

/** A receipt the model's reading set aside as no receipt: its verdict is its kind, it has no text to read. */
const setAsideByReading = (r: Receipt | undefined) => r?.kind === 'noise' && r.kindRule === `${MODEL_RULE}no-receipt` && !r.extractedText;

// ─── The step ────────────────────────────────────────────────────────────────

export const readStep: StepRun = async ({ ws, books, ask, progress, log, later, arrived }) => {
  // First: a statement that belongs to no bank account stops the step before receipts are read.
  const bank = readTransactions(ws);
  for (const f of bank.files) {
    if (f.status === 'duplicate') log(`  skip ${f.file}: statement ${f.statement.id} is already read from ${f.of}`);
    if (f.status === 'skipped') log(`  skip ${f.file}: ${f.reason}`);
  }
  const unmatched = unmatchedOf(bank);
  if (unmatched.length) return { notes: [{ code: 'unmatched', files: unmatched }], stop: true };
  // A photo's row in the drop dialog follows the PDF it became: the file has a new name and the id of its new bytes (r8k-9).
  // A photo of a run waiting behind this one is left to that run, which renames its own row (r4c-7).
  for (const c of await convertImagesToPdf(ws.paths.inbox, log, later?.())) arrived?.renamed(c.from, { inbox: c.to, id: idOf(join(ws.paths.inbox, c.to)) });

  // Archived receipts first, then staged (for cross-folder duplicate detection)
  const archivedFiles = archivedPdfs(ws);
  const twice = archivedFiles.filter((f, i) => archivedFiles.findIndex((g) => g.filename === f.filename) !== i);
  if (twice.length) return { notes: [{ code: 'error', detail: `${twice.map((f) => f.filename).join(', ')}: in two year folders' receipts/, keep one` }], stop: true };
  // Asked at the scan, not at the step's start: a file that came in meanwhile with a run waiting behind this one is that run's (r4c-7).
  const theirs = later?.();
  for (const f of unreadablePdfs(ws.paths.inbox).filter((f) => !theirs?.has(stemOf(f)))) {
    const path = join(ws.paths.inbox, f);
    const held = putInQuarantine(ws.paths.data, f, readFileSync(path), { kind: 'unreadable' });
    unlinkSync(path);
    arrived?.refused(f, 'unreadable');
    log(`  ${f} is no PDF inside: moved to quarantine as ${held}`);
  }
  const stagedFiles = scanPdfs(ws.paths.inbox, 'staged').filter((f) => !theirs?.has(stemOf(f.filename)));
  log(`Found ${archivedFiles.length} PDFs in receipts/, ${stagedFiles.length} PDFs in beleg-import/\n`);

  const files: Array<FoundFile & { id: string }> = [];
  const seen = new Map<string, string>();
  // A file in the inbox with the bytes of one the books or the inbox hold already (a phone's
  // retry, the same scan sent twice) is that file: it leaves the inbox, and the run says so.
  const sameBytes: Array<{ file: string; of: string }> = [];
  for (const f of [...archivedFiles, ...stagedFiles]) {
    const id = idOf(f.filepath);
    const first = seen.get(id);
    if (first) {
      if (f.location === 'staged') {
        unlinkSync(f.filepath);
        sameBytes.push({ file: f.filename, of: first });
        log(`  ${f.filename} in beleg-import/ has the same bytes as ${first}: removed`);
      } else log(`  DUPE  ${f.filename} (same content as ${first})`);
      continue;
    }
    seen.set(id, f.filename);
    files.push({ ...f, id });
  }

  const snapshot = books.read();
  const known = new Map(snapshot.receipts.map((r) => [r.id, r]));
  const again = new Set(ask ? snapshot.receipts.filter((r) => readsAgain(snapshot, r)).map((r) => r.id) : []);
  // A file its reading set aside as no receipt has no text and is not read again, until a person says it is one (#361).
  const toExtract = files.filter((f) => (!known.get(f.id)?.extractedText && !setAsideByReading(known.get(f.id))) || again.has(f.id));
  progress(0, toExtract.length);

  const pool = createPool(5);
  const extracted = new Map<string, Extracted>();
  let waitingForModel = 0;
  await Promise.all(toExtract.map((f) => pool(async () => {
    // Only a file new to the books may be set aside by its reading: one a person declared a receipt is only read again.
    const out = await extractTextFast(f.filepath, ask, log, !known.has(f.id));
    if (out.vision === 'none') waitingForModel++;
    extracted.set(f.id, { text: out.text, method: out.method, fileSize: statSync(f.filepath).size, ...(out.verdict ? { verdict: out.verdict } : {}) });
    progress(extracted.size, toExtract.length);
    log(`  [${extracted.size}/${toExtract.length}] ${f.filename} → ${out.method}, ${out.text.length} chars${detectVatProofIssue(out.text) ? '  ⚠ VAT proof missing' : ''}`);
  })));

  // A new receipt whose words decide nothing and that shows almost nothing of an invoice is asked of the model once (#186).
  const modelKinds = new Map<string, ModelKind>();
  // A receipt read again keeps the kind it has; a reading that proves nothing (a photo the model could not read) says nothing of its kind and waits as «nicht lesbar» (#284).
  const unclear = ask ? toExtract.filter((f) => {
    const read = extracted.get(f.id);
    return !again.has(f.id) && !known.get(f.id)?.kind && !known.get(f.id)?.kindBy && !!read && !read.verdict && textProves({ extractedText: read.text, extractionMethod: read.method }) && asksModel(read.text, documents());
  }) : [];
  await Promise.all(unclear.map((f) => pool(async () => {
    try {
      const v = await askKind(ask!, extracted.get(f.id)!.text, f.filename);
      if (v) modelKinds.set(f.id, v);
      const length = extracted.get(f.id)!.text.length;
      const cut = length > MODEL_TEXT ? `, from the first ${MODEL_TEXT} of ${length} characters` : '';
      log(`  ${f.filename}: ${v ? `${v.is}${v.why ? ` (${v.why})` : ''}` : 'no verdict in the answer'}${cut}`);
    } catch (e: any) {
      log(`  ${f.filename}: what it is stays unclear, the model failed: ${e.message?.substring(0, 100)}`);
    }
  })));

  // A statement PDF kept as its statement is read for what its bank export lacks (#243): a month's worth by the run, a larger backlog once the person asks for it.
  const unread = ask ? unreadPdfs(ws, { ...books.read(), bankStatements: readStatementFiles(ws).statements }) : [];
  const readFailed: { file: string; error: string }[] = [];
  if (unread.length && readsByItself(unread)) readFailed.push(...(await readKeptPdfs(unread, ask!, { log })).failed);
  else if (unread.length) log(`  ${unread.length} statement PDF(s) not read yet: Kontoauszüge › «${unread.length} Kontoauszüge von der KI lesen lassen?», or npm run read-statements`);
  const statementFiles = readStatementFiles(ws);
  const invoices = loadInvoices(ws);
  const payments = paymentContext(ws);

  // Everything read from disk is read again here, in the one synchronous change: a file deleted
  // or a statement uploaded while the texts were read is not undone.
  const outcome = books.update((index) => {
    const now = readTransactions(ws);
    const stillUnmatched = unmatchedOf(now);
    if (stillUnmatched.length) throw new Error(`Kontoauszug ohne Bankkonto: ${stillUnmatched.join('; ')}`);
    const byId = new Map(index.receipts.map((r) => [r.id, r]));
    const receipts = files.filter((f) => existsSync(f.filepath)).flatMap(({ id, filename, location }): Receipt[] => {
      const existing = byId.get(id);
      const read = extracted.get(id);
      // Read again (#284): the new text replaces the one read before, if that is still the receipt's, and so do the VAT facts read
      // off it. An archived receipt is matched no more: a day or total it lacks is taken where the text states it plainly; one it has may be a person's.
      if (read?.text && existing?.extractedText && again.has(id) && existing.extractedText === known.get(id)?.extractedText) {
        const plain = textFacts(read.text);
        const r: Receipt = {
          ...existing, filename, location, extractedText: read.text, extractionMethod: read.method, needsVisionReview: undefined,
          date: existing.date ?? plain.date, amount: existing.amount ?? plain.amount, currency: existing.currency ?? plain.currency,
          remarks: existing.remarks ?? detectVatProofIssue(read.text),
        };
        forgetReadFacts(r);
        log(`  ${filename}: read again by the model, its earlier text proved nothing`);
        return [r];
      }
      const fresh = existing?.extractedText ? undefined : read;
      if (!fresh) return existing ? [{ ...existing, filename, location, remarks: existing.remarks ?? detectVatProofIssue(existing.extractedText) }] : [];
      // Without a model nothing else reads the date and the total; what the text states plainly is taken.
      const plain = ask ? {} : textFacts(fresh.text);
      const originalFilename = existing?.originalFilename ?? filename;
      // A kind given before the text was read (a person's, above all) stays as it is.
      const { date: periodEnd, ...kind }: Pick<Receipt, 'kind' | 'kindBy' | 'kindRule' | 'kindWhy' | 'date'> = existing?.kind || existing?.kindBy
        ? { kind: existing.kind, kindBy: existing.kindBy, kindRule: existing.kindRule, kindWhy: existing.kindWhy }
        : kindOfText(fresh, filename, originalFilename, modelKinds.get(id));
      return [{
        id,
        filename,
        originalFilename,
        extractedText: fresh.text,
        extractionMethod: fresh.method,
        fileSize: fresh.fileSize,
        indexedAt: existing?.indexedAt ?? new Date().toISOString(),
        location,
        date: existing?.date ?? periodEnd ?? plain.date,
        description: existing?.description,
        amount: existing?.amount ?? plain.amount,
        currency: existing?.currency ?? plain.currency,
        needsVisionReview: (fresh.text.length === 0 && !fresh.verdict) || undefined,
        remarks: existing?.remarks ?? detectVatProofIssue(fresh.text),
        ...kind,
      } as Receipt];
    });
    // The books keep their order, new receipts after them: a second run writes the same file.
    const pos = new Map(index.receipts.map((r, i) => [r.id, i]));
    receipts.sort((a, b) => (pos.get(a.id) ?? pos.size) - (pos.get(b.id) ?? pos.size));
    const { kept, before } = withinBooks(now.transactions, index.config);
    if (kept.length < now.transactions.length) {
      log(`  skipped ${now.transactions.length - kept.length} bank transaction(s) dated before ${before}, when the books open (config.openingBalances)`);
    }
    const merged = mergeIndex(index, { receipts, bankTransactions: assignUniqueRefs(kept), reads: keptReads(ws, statementFiles.statements, index.statementAsks), bankStatements: statementFiles.statements, camtBalances: statementFiles.balances });
    Object.assign(index, merged.index);
    // Movements read from PDFs and the bank's file of the same days: the account's reconciliation, before any run books them (#254).
    reconcileWithFiles(ws, index, differenceAccountOf(ws));
    // On the agreed basis each issued document's VAT event comes before its payment, which then only settles the receivable (src/invoices/events.ts).
    const events = payments ? bookInvoiceEvents(index, invoices, payments) : undefined;
    if (events) fileReceipts(ws, index, events.files);
    if (events?.skipped.length) log(`  VAT of ${events.skipped.map((s) => s.number).join(', ')} not booked: no official rate of the invoice's day yet (npm run fetch-rates); the VAT filing waits for it`);
    // Paid invoices first (ADR 0010): a payment with an invoice's reference or number, or a credit note's refund, is booked from the document before classify sees it.
    const paid = payments ? matchPayments(index, invoices, payments) : undefined;
    if (paid) {
      fileReceipts(ws, index, paid.files);
      saveInvoices(ws, invoices);
    }
    return { ...merged, paid, counts: { receipts: index.receipts, transactions: index.transactions.length, statements: index.bankStatements.length, mappings: index.mappings.length } };
  });

  const { counts, paid, brokenClosedLinks, vanishedClosedTransactions } = outcome;
  log(`\nDone.`);
  log(`  ${counts.receipts.filter((r) => r.location === 'archived').length} archived receipts (receipts/)`);
  log(`  ${counts.receipts.filter((r) => r.location === 'staged').length} staged receipts (beleg-import/)`);
  log(`  ${counts.transactions} transactions`);
  log(`  ${counts.statements} bank statement PDFs`);
  log(`  ${counts.mappings} mappings`);
  if (paid) reportPayments(paid, log);

  const flagged = counts.receipts.filter((r) => r.remarks?.startsWith('⚠ VAT PROOF MISSING'));
  if (flagged.length > 0) {
    log(`\n⚠ ${flagged.length} receipt(s) flagged: no VAT proof (see remarks in UI):`);
    for (const r of flagged) log(`    ${r.filename}`);
  }

  // Golden rule 1: a filed quarter's evidence is never dropped silently. These were kept as
  // they were; a person must fix them (re-link the receipt, restore the camt053 file).
  const notes: IntakeNote[] = [];
  if (brokenClosedLinks.length > 0) {
    log(`\n⛔ ${brokenClosedLinks.length} receipt link(s) in a FILED quarter point at a receipt file that is gone (re-downloaded or compressed PDFs get a new id). Kept; re-link them by hand:`);
    for (const m of brokenClosedLinks) log(`    ${m.transactionRef} → ${m.receiptId} (${known.get(m.receiptId)?.filename ?? 'unknown file'})`);
  }
  if (vanishedClosedTransactions.length > 0) {
    log(`\n⛔ ${vanishedClosedTransactions.length} bank transaction(s) in a FILED quarter are in no camt053 file any more. Kept as they were; restore the bank statement file:`);
    for (const t of vanishedClosedTransactions) log(`    ${t.date} ${t.ref} ${t.amount} ${t.currency} ${t.description}`);
  }
  const kept = brokenClosedLinks.length + vanishedClosedTransactions.length;
  if (kept) notes.push({ code: 'filedKept', count: kept });
  if (waitingForModel) notes.push({ code: 'noModel', waiting: waitingForModel });
  if (readFailed.length) notes.push({ code: 'failed', count: readFailed.length, detail: `${readFailed[0].file}: ${readFailed[0].error}` });
  if (sameBytes.length) notes.push({ code: 'sameBytes', files: sameBytes });
  return { notes };
};

function reportPayments(paid: PaymentOutcome, log: (line: string) => void): void {
  for (const p of paid.paid) {
    log(`  ${p.number}: ${p.amount.toFixed(2)}${p.fee ? ` + Mahngebühr ${p.fee.toFixed(2)}` : ''} bezahlt (${p.transactionRef})${p.booked ? ', Ertrag gebucht' : ''}`);
  }
  const why = { cancelled: 'die Rechnung ist storniert', currency: 'andere Währung als die Rechnung', surplus: 'mehr als offen', batch: 'Sammelzahlung mit Teilen ohne Rechnung, nicht gebucht', booked: 'die Zahlung ist schon gebucht, ohne die Rechnung', closed: 'in einer abgeschlossenen Periode' };
  for (const q of paid.questions) log(`  ⚠ Zahlung ${q.transactionRef} (${q.amount.toFixed(2)}) zu ${q.number}: ${why[q.problem]}. Bitte entscheiden.`);
}
