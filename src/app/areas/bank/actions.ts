/**
 * What Kontoauszüge writes: a payment marked as needing no receipt and a payment's note (undo through the toast), and
 * statements added from a file (the add button, N, a drop, or a missing month's well) through
 * POST /api/statements, which reads them into the books as `npm run extract` would.
 */
import { startIntake } from '../../automation/intake.js';
import { automationCommand } from '../../automation/store.js';
import { commandRefusalText } from '../../automation/refusal.js';
import { startAndSay } from '../../automation/marks.js';
import type { BankTransaction, StatementImport } from '../../../types/index.js';
import type { OpeningOffer } from '../../../accounting/opening-balance.js';
import type { ReceiptSet } from '../../../intake/receipt-sets.js';
import { fmt } from '../../lib/utils.js';
import { baseCurrency } from '../../../engines/index.js';
import { ApiError, api, errorText } from '../../lib/api.js';
import { dropFiles } from '../../shell/DropDialog.js';
import { t } from '../../i18n/index.js';
import type { Area, Nav } from '../index.js';
import { at } from '../receipts/view.js';
import { fileKey, type Account, type Statement } from './model.js';
import { forgetPages } from './StatementPaper.js';

/**
 * Marks a payment as needing no receipt, or takes the mark back. `unbooked`: the payment has no
 * booking; the receipt was what it waited for, so the mark goes on to book it in the same step
 * (by a rule or the model, #340), and the toast says what came of it: booked, or why not yet.
 */
export async function setNoReceipt(nav: Nav, tx: BankTransaction, on: boolean, undoing = false, unbooked = false): Promise<void> {
  try {
    await api.patchTransaction(tx.ref, { noReceiptNeeded: on });
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  nav.refresh();
  const undo = () => setNoReceipt(nav, tx, !on, true);
  if (undoing) return;
  if (!on || !unbooked) return nav.toast(t(on ? 'bank.noReceiptSet' : 'bank.noReceiptCleared'), undo);
  nav.toast(t('bank.noReceiptBooking'), undo);
  try {
    const said = await startAndSay('booking', { kind: 'transaction', id: tx.ref });
    // One toast carries the outcome and the undo: the undo stays reachable after the run rested, and says what it takes back.
    if (said) nav.toast(t('bank.noReceiptResult', { said }), undo);
  } catch (e) {
    nav.toast(errorText(e), undo);
  }
  nav.refresh();
}

/**
 * The receipts code proposes for one payment (#27), linked in one click, as a whole: a link refused
 * on the way takes back those made before it. The toast's undo takes every link back.
 */
export async function linkReceiptSet(nav: Nav, s: ReceiptSet, undoing = false): Promise<void> {
  // Every movement of the charge: a card charge split across balances is linked on each leg (#190).
  const pairs = s.legs.flatMap((transactionRef) => s.receipts.map((receiptId) => ({ receiptId, transactionRef })));
  const done: typeof pairs = [];
  try {
    for (const p of pairs) { await (undoing ? api.removeMapping(p) : api.addMapping(p)); done.push(p); }
  } catch (e) {
    if (!undoing) for (const p of done) await api.removeMapping(p).catch(() => undefined);
    nav.toast(errorText(e));
    nav.refresh();
    return;
  }
  nav.refresh();
  if (!undoing) nav.toast(t('bank.receiptSet.linked', { n: s.receipts.length }), () => linkReceiptSet(nav, s, true));
}

/**
 * A payment that waited for its receipt, booked without one in one click (issue #29): marked as
 * needing none, which gives it the zero input-tax code, and handed to «Buchen» at once. A receipt
 * linked later books it again with its VAT, while the period is open.
 */
export async function bookWithoutInputTax(nav: Nav, tx: BankTransaction): Promise<void> {
  try {
    await api.patchTransaction(tx.ref, { noReceiptNeeded: true });
    const r = await automationCommand({ kind: 'start', workflow: 'booking', item: { kind: 'transaction', id: tx.ref } });
    nav.toast(r.ok ? t('receiptDue.booking') : commandRefusalText(r));
  } catch (e) {
    nav.toast(errorText(e));
  }
  nav.refresh();
}

/** The payment's note; an empty one removes it. */
export async function setNote(nav: Nav, tx: BankTransaction, text: string, undoing = false): Promise<void> {
  const before = tx.remarks ?? '';
  if (text === before) return;
  try {
    await api.patchTransaction(tx.ref, { remarks: text });
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  nav.refresh();
  if (!undoing) nav.toast(t(text ? 'bank.noteSaved' : 'bank.noteCleared'), () => setNote(nav, { ...tx, remarks: text }, before, true));
}

/** A statement's opening balance as the account's opening of the books; the toast's undo takes it back. */
export async function takeOpening(nav: Nav, o: OpeningOffer, undoing = false): Promise<void> {
  try {
    await api.setOpeningBalance(o.year, o.account, undoing ? null : o.amount);
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  nav.refresh();
  if (!undoing) nav.toast(t('bank.openingTaken', { amount: `${baseCurrency()} ${fmt(o.amount)}` }), () => takeOpening(nav, o, true));
}

const STATEMENT_FILE = /\.(xml|pdf)$/i;

/** The statement's key in a link, as Kontoauszüge lists it. */
const keyOf = (s: Pick<StatementImport, 'account' | 'from' | 'to' | 'month'>) => (s.from ? fileKey(s.account, s.from, s.to) : `${s.account}-${s.month}`);

/**
 * Reads each file in as a statement; Kontoauszüge opens the last one read, in the period it covers.
 * The toast's «Rückgängig» takes the files read out again, the same way the drop dialog's does
 * (r9k-3). `into`: the missing month a file is for.
 */
export async function importStatements(files: File[], nav: Nav, into?: { account: Account; month: string }): Promise<void> {
  const ok = files.filter((f) => STATEMENT_FILE.test(f.name));
  // Any other file (a photo, a ZIP) goes through the drop dialog, which reads what it is and gives it its row (#361).
  const others = files.filter((f) => !ok.includes(f));
  const read: StatementImport[] = [];
  for (const [i, f] of ok.entries()) {
    try {
      read.push(await api.importStatement(f, f.name, into && { account: into.account.account, month: into.month }));
    } catch (e) {
      // Several accounts could take it: the drop dialog asks which, and takes the rest after it (#25). A PDF no
      // camt.053 covers goes there too: it is read into its movements, or kept as the month's statement (#217).
      if (e instanceof ApiError && e.body.code === 'statement' && (e.body.params.problem?.kind === 'whichAccount' || e.body.params.reason === 'read')) {
        if (read.length) nav.refresh();
        void dropFiles([...ok.slice(i), ...others]);
        return;
      }
      // The files after it are not left out without a word: the drop dialog takes them.
      const rest = [...ok.slice(i + 1), ...others];
      if (rest.length) void dropFiles(rest);
      nav.toast(`${f.name}: ${errorText(e)}`);
      if (read.length) nav.refresh();
      return;
    }
  }
  const last = read.at(-1);
  const added = read.reduce((n, r) => n + r.added, 0);
  const confirmed = read.reduce((n, r) => n + (r.confirmed ?? 0), 0);
  const reconcile = read.reduce((n, r) => n + (r.reconcile?.read ?? 0), 0);
  const asksClosed = read.reduce((n, r) => n + (r.closedAsks ?? 0), 0);
  const imported = [t('bank.imported', { n: added }), confirmed ? t('bank.importConfirmed', { n: confirmed }) : '', reconcile ? t('bank.importReconcile', { n: reconcile }) : '', asksClosed ? t('bank.importAsksClosed', { n: asksClosed }) : ''].filter(Boolean).join(' · ');
  const undo = last ? async () => {
    for (const r of [...read].reverse()) {
      try { await api.deleteStatement(r.file); } catch (e) { nav.toast(errorText(e)); break; }
    }
    forgetPages();
    nav.refresh();
  } : undefined;
  if (others.length) void dropFiles(others);
  if (last) nav.toast(imported, undo);
  if (!last) return;
  void startIntake();
  forgetPages();
  nav.refresh();
  nav.go(at({ area: 'bank', statement: keyOf(last) }, last.to));
}

/**
 * «Auszug entfernen» on a statement's page: the file leaves the books as the drop dialog's undo
 * takes it (its payments, their links and entries, its balances; a hand booking refuses it). The
 * toast's «Rückgängig» puts the file and every record the removal changed back as they were (r9k-3).
 */
export async function removeStatement(nav: Nav, s: Statement): Promise<void> {
  if (!s.file) return;
  let undo: string;
  try {
    ({ undo } = await api.deleteStatement(`${s.file.bank}/${s.file.filename}`));
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  forgetPages();
  nav.refresh();
  nav.toast(t('bank.statementRemoved', { name: s.file.filename }), () => {
    api.restoreStatement(undo).then(() => { forgetPages(); nav.refresh(); nav.go(at({ area: 'bank', statement: s.key }, s.to)); }, (e) => nav.toast(errorText(e)));
  });
  nav.go(at({ area: 'bank' }, s.to));
}

/** Opens the system's file dialog for camt.053 and statement PDFs. */
export function pickStatements(onFiles: (files: File[]) => void): void {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.xml,.pdf,application/xml,text/xml,application/pdf' });
  input.onchange = () => onFiles([...(input.files ?? [])]);
  input.click();
}

export const statementAdd: NonNullable<Area['add']> = {
  label: () => t('bank.add'),
  title: () => t('bank.addTitle'),
  run: ({ nav }) => pickStatements((files) => importStatements(files, nav)),
};
