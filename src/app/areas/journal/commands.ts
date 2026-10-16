/** What the list, the detail and the keys of Buchungen share: the journal of the loaded books, and the commands on an entry. */
import type { Index, JournalEntry, Receipt } from '../../../types/index.js';
import { correctionKinds, correctionOf, type CorrectionKind } from '../../../accounting/correction.js';
import { workspaceNow } from '../../hooks/use-workspace.js';
import { localToday, booksOpenPeriod, filingKeyOf, type Period } from '../../../accounting/periods.js';
import type { RouteOf } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { splitTitle } from '../receipts/model.js';
import { at } from '../receipts/view.js';
import { journalOf, type Journal } from './model.js';
import { listed, setUi, ui } from './state.js';
import { deleteEntry } from './actions.js';
import { filing } from '../../../engines/index.js';
import { isAccrual, newYearAfter, reversalOf } from '../../../accounting/reversal.js';

type Props = AreaProps<RouteOf<'journal'>>;

let memo: { books: Index; journal: Journal } | undefined;

/** The journal of these books, computed once per load. */
export function journalFor(books: Index): Journal {
  if (memo?.books !== books) memo = { books, journal: journalOf(books) };
  return memo.journal;
}

/** The quarter new entries go in: the first one after the filed ones. */
export const openPeriod = (books: Index): Period => booksOpenPeriod(books, localToday(), filing().length);

/** The day a new entry starts on: today, unless today is filed (then the open quarter's first day). */
export function newEntryDate(books: Index): string {
  const today = localToday();
  const closed = books.config?.closedThrough;
  return closed && today <= closed ? openPeriod(books).from : today;
}

export const splitReceipt = (r: Receipt) => splitTitle(r.description || r.filename.replace(/\.pdf$/i, ''));

/** The bank accounts statements come for: a correction or an entry typed by hand should not move them. */
export const isBankAccount = (account: string): boolean =>
  !!workspaceNow()?.bankAccounts.some((b) => b.account === account && b.bank !== 'manual');

/** Opens the correction form of a filed entry for what was wrong with it. */
export function correct(books: Index, e: JournalEntry, as: CorrectionKind): void {
  setUi({ overlay: { kind: 'new', correcting: { entry: e.id, as }, draft: {
    ...correctionOf(e, as, newEntryDate(books), t('journal.correctionText', { ref: e.transactionRef, text: e.description ?? '' }), isBankAccount),
    corrects: e.date ? filingKeyOf(e.date, filing().length) : undefined,
  } } });
}

export type Act = 'edit' | 'del' | 'correct' | 'reverse' | 'reverseNewYear' | 'copy' | 'receipt' | 'payment' | 'download';

/** An action on the selected entry, from a button or a key. One that changes it refuses a filed entry with the reason. */
export function runAct(p: Props, a: Act, id = p.route.id): boolean {
  const v = id ? journalFor(p.books).byId.get(id) : undefined;
  if (!v) return false;
  const { e } = v;
  switch (a) {
    case 'receipt': {
      const r = v.receipts[0];
      if (r) p.nav.go(at({ area: 'receipts', id: r.id }, r.date));
      return !!r;
    }
    case 'payment':
      if (v.tx) p.nav.go(at({ area: 'bank', payment: v.tx.ref }, v.tx.date));
      return !!v.tx;
    case 'download': {
      const link = document.querySelector<HTMLAnchorElement>('.detail a.dl');
      link?.click();
      return !!link;
    }
    // A correction starts with what is most often wrong: the VAT code taken back, the bank left alone (corner-29).
    case 'correct':
      if (!p.canEdit) return false;
      correct(p.books, e, correctionKinds(e)[0]);
      return true;
    // A Gegenbuchung of an open entry, its accrual's reversal on the next 1.1., a copy (treuhaender-27).
    case 'reverse':
      if (!p.canEdit || v.locked) return false;
      setUi({ overlay: { kind: 'new', draft: reversalOf(e, newEntryDate(p.books), t('journal.reverseText', { ref: e.transactionRef, text: e.description ?? '' })) } });
      return true;
    case 'reverseNewYear':
      if (!p.canEdit || !isAccrual(e)) return false;
      setUi({ overlay: { kind: 'new', draft: reversalOf(e, newYearAfter(e.date), t('journal.accrualText', { text: e.description ?? '', year: e.date.slice(0, 4) })) } });
      return true;
    case 'copy':
      if (!p.canEdit) return false;
      setUi({ overlay: { kind: 'new', draft: {
        date: newEntryDate(p.books), accountDebit: e.accountDebit, accountCredit: e.accountCredit, amount: e.amount,
        ...(e.vatCode && { vatCode: e.vatCode }), description: e.description ?? '',
      } } });
      return true;
  }
  if (!p.canEdit) return false;
  if (v.locked || e.origin === 'year-close') { p.nav.toast(v.locked ? t('journal.lockedToast') : t('error.yearClose')); return true; }
  if (a === 'edit') setUi({ open: { ...ui().open, buchung: true }, focus: 'accountDebit' });
  if (a === 'del') {
    const i = listed.ids.indexOf(e.id);
    const next = listed.ids[i + 1] ?? listed.ids[i - 1];
    deleteEntry(p.nav, e).then((ok) => { if (ok && next) p.nav.select({ area: 'journal', id: next }); });
  }
  return true;
}
