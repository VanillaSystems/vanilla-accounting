/**
 * What Kontoauszüge writes: a payment marked as needing no receipt and a payment's note (undo through the toast), and
 * statements added from a file (the add button, N, a drop, or a missing month's well) through
 * POST /api/statements, which reads them into the books as `npm run extract` would.
 */
import { startIntake } from '../../automation/intake.js';
import type { BankTransaction } from '../../../types/index.js';
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Area, Nav } from '../index.js';
import type { Account } from './model.js';
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

const STATEMENT_FILE = /\.(xml|pdf)$/i;

/** Reads each file in as a statement; Kontoauszüge opens the last one read. `into`: the missing month a file is for. */
export async function importStatements(files: File[], nav: Nav, into?: { account: Account; month: string }): Promise<void> {
  const ok = files.filter((f) => STATEMENT_FILE.test(f.name));
  const skipped = files.filter((f) => !ok.includes(f)).map((f) => f.name);
  let last: { account: string; month: string } | undefined;
  let added = 0;
  for (const f of ok) {
    try {
      const r = await api.importStatement(f, f.name, into && { account: into.account.account, month: into.month });
      last = r;
      added += r.added;
    } catch (e) {
      nav.toast(`${f.name}: ${errorText(e)}`);
      if (last) nav.refresh();
      return;
    }
  }
  if (skipped.length) nav.toast([last && t('bank.imported', { n: added }), t('bank.importSkipped', { names: skipped.join(', ') })].filter(Boolean).join(' · '));
  else if (last) nav.toast(t('bank.imported', { n: added }));
  if (!last) return;
  void startIntake();
  forgetPages();
  nav.refresh();
  nav.go({ route: { area: 'bank', statement: `${last.account}-${last.month}` }, query: {} });
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
