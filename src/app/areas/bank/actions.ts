/**
 * What Kontoauszüge writes: a payment marked as needing no receipt and a payment's note (undo through the toast), and
 * statements added from a file (the add button, N, a drop, or a missing month's well) through
 * POST /api/statements, which reads them into the books as `npm run extract` would.
 */
import { startIntake } from '../../automation/intake.js';
import type { BankTransaction, StatementImport } from '../../../types/index.js';
import type { OpeningOffer } from '../../../accounting/opening-balance.js';
import { fmt } from '../../lib/utils.js';
import { baseCurrency } from '../../../engines/index.js';
import { api, errorText, sources } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Area, Nav } from '../index.js';
import { at } from '../receipts/view.js';
import { fileKey, type Account, type Statement } from './model.js';
import { forgetPages } from './StatementPaper.js';

export async function setNoReceipt(nav: Nav, tx: BankTransaction, on: boolean, undoing = false): Promise<void> {
  try {
    await api.patchTransaction(tx.ref, { noReceiptNeeded: on });
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  nav.refresh();
  if (!undoing) nav.toast(t(on ? 'bank.noReceiptSet' : 'bank.noReceiptCleared'), () => setNoReceipt(nav, tx, !on, true));
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
  const skipped = files.filter((f) => !ok.includes(f)).map((f) => f.name);
  const read: StatementImport[] = [];
  for (const f of ok) {
    try {
      read.push(await api.importStatement(f, f.name, into && { account: into.account.account, month: into.month }));
    } catch (e) {
      nav.toast(`${f.name}: ${errorText(e)}`);
      if (read.length) nav.refresh();
      return;
    }
  }
  const last = read.at(-1);
  const added = read.reduce((n, r) => n + r.added, 0);
  const undo = last ? async () => {
    for (const r of [...read].reverse()) {
      try { await api.deleteStatement(r.file); } catch (e) { nav.toast(errorText(e)); break; }
    }
    forgetPages();
    nav.refresh();
  } : undefined;
  if (skipped.length) nav.toast([last && t('bank.imported', { n: added }), t('bank.importSkipped', { names: skipped.join(', ') })].filter(Boolean).join(' · '), undo);
  else if (last) nav.toast(t('bank.imported', { n: added }), undo);
  if (!last) return;
  void startIntake();
  forgetPages();
  nav.refresh();
  nav.go(at({ area: 'bank', statement: keyOf(last) }, last.to));
}

/**
 * «Auszug entfernen» on a statement's page: the file leaves the books as the drop dialog's undo
 * takes it (its payments, their links and entries, its balances; a hand booking refuses it). The
 * toast's «Rückgängig» reads the same file in again, so nothing is lost by a wrong click (r9k-3).
 */
export async function removeStatement(nav: Nav, s: Statement): Promise<void> {
  if (!s.file) return;
  const file = `${s.file.bank}/${s.file.filename}`;
  let bytes: Blob | undefined;
  try {
    bytes = await (await fetch(sources.statement(s.file.bank, s.file.filename))).blob();
    await api.deleteStatement(file);
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  forgetPages();
  nav.refresh();
  const kept = bytes;
  nav.toast(t('bank.statementRemoved', { name: s.file.filename }), () => {
    api.importStatement(kept, s.file!.filename, { account: s.account.account, month: s.from.slice(0, 7) })
      .then((r) => { forgetPages(); nav.refresh(); nav.go(at({ area: 'bank', statement: keyOf(r) }, r.to)); }, (e) => nav.toast(errorText(e)));
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
