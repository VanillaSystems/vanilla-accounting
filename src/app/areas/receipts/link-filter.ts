/**
 * The chip filter of «Zahlung verknüpfen» (#232): Konto (each money account of the workspace by its
 * label, currency and role), Betrag über/unter/genau, Ab/Bis, Richtung, Beleg. A row is a payment or
 * a booking without one; a booking moved on no money account and in no direction, so a Konto or
 * Richtung chip leaves it out. The Konto chips stay chosen for the next receipt in this browser tab
 * (a per-viewer convenience: sessionStorage, never the books).
 */
import type { BankTransaction } from '../../../types/index.js';
import type { LedgerBankAccount } from '../../../workspace/workspace.js';
import { accountOf } from '../../../workspace/money-accounts.js';
import { rangeFields, type Chip, type Field, type FieldWords } from '../../shell/chips.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { candidates, type Ledger, type ReceiptView, type ToChf, type Unpaid } from './model.js';

export interface LinkRow { ref: string; date: string; amount: number; tx?: BankTransaction }
export const rowOfTx = (tx: BankTransaction): LinkRow => ({ ref: tx.ref, date: tx.date, amount: tx.amount, tx });
export const rowOfUnpaid = (u: Unpaid): LinkRow => ({ ref: u.ref, date: u.date, amount: u.amount });

/** The Konto field's id: its chips are the ones remembered and toggled by ⌥1…9. */
export const ACCOUNT = 'account';
/** A money account as a chip value: its label of the statements and its currency (one manifest row). */
export const accountValue = (a: Pick<LedgerBankAccount, 'bank' | 'currency'>): string => `${a.bank} ${a.currency}`;
/** A money account's name with its currency: «Wise EUR», «Bank Raiffeisen» with its currency added. */
export const accountName = (a: Pick<LedgerBankAccount, 'label' | 'currency'>): string => (a.label.includes(a.currency) ? a.label : `${a.label} ${a.currency}`);

const WAYS = ['out', 'in'] as const;
const RECEIPT = ['no', 'yes'] as const;
const isOne = <T extends string>(xs: readonly T[], v: string): v is T => (xs as readonly string[]).includes(v);

export function linkFields(accounts: readonly LedgerBankAccount[], l: Pick<Ledger, 'receiptsByRef'>, { say: t, monthName }: FieldWords): Array<Field<LinkRow>> {
  const byValue = new Map(accounts.map((a) => [accountValue(a), a]));
  const accountLabel = (v: string) => {
    const a = byValue.get(v);
    if (!a) return v;
    return `${accountName(a)} · ${t(`company.role.${a.role}`)}`;
  };
  const [over, under, amount, , from, to] = rangeFields<LinkRow>((r) => r.amount, (r) => r.date, {
    over: () => t('chips.field.over'), under: () => t('chips.field.under'), exact: () => t('chips.field.amount'),
    month: () => t('chips.field.month'), from: () => t('chips.field.from'), to: () => t('chips.field.to'),
    money: fmt, day: formatDate, monthName,
  });
  return [
    {
      id: ACCOUNT, label: () => t('chips.field.account'), input: 'pick', multi: true,
      options: () => accounts.map((a) => ({ value: accountValue(a), label: accountLabel(accountValue(a)) })),
      valueLabel: accountLabel,
      test: (v) => {
        const a = byValue.get(v);
        return a ? (r) => !!r.tx && accountOf(r.tx, accounts) === a : undefined;
      },
    },
    over, under, amount, from, to,
    {
      id: 'way', label: () => t('chips.field.way'), input: 'pick', multi: false,
      options: () => WAYS.map((w) => ({ value: w, label: t(`chips.way.${w}`) })),
      valueLabel: (w) => (isOne(WAYS, w) ? t(`chips.way.${w}`) : w),
      test: (w) => (isOne(WAYS, w) ? (r) => !!r.tx && (r.tx.direction === 'CRDT') === (w === 'in') : undefined),
    },
    {
      id: 'receipt', label: () => t('chips.field.receipt'), input: 'pick', multi: false,
      options: () => RECEIPT.map((y) => ({ value: y, label: t(`chips.receipt.${y}`) })),
      valueLabel: (y) => (isOne(RECEIPT, y) ? t(`chips.receipt.${y}`) : y),
      test: (y) => (isOne(RECEIPT, y) ? (r) => ((l.receiptsByRef.get(r.ref) ?? []).length > 0) === (y === 'yes') : undefined),
    },
  ];
}

/** How many of the receipt's best fits without the filter the filter hides: «1 passende Zahlung ausgeblendet durch den Filter». */
export const hiddenBest = (v: ReceiptView, l: Ledger, toChf: ToChf, keep: (row: LinkRow) => boolean): number =>
  candidates(v, l, toChf).best.filter((c) => !keep(rowOfTx(c.tx))).length;

/** ⌥1…9 toggles the n-th money account's chip (in the order the dialog shows them). */
export function toggleAccount(chips: readonly Chip[], accounts: readonly LedgerBankAccount[], n: number): Chip[] | undefined {
  const a = accounts[n - 1];
  if (!a) return undefined;
  const value = accountValue(a);
  return chips.some((c) => c.field === ACCOUNT && c.value === value)
    ? chips.filter((c) => !(c.field === ACCOUNT && c.value === value))
    : [...chips, { field: ACCOUNT, value }];
}

const KEY = 'vanilla.link.accounts';
/** Where sessionStorage is missing or refuses (a private window, Node): the chips live as long as the page. */
let kept: string[] = [];

/** The Konto chips chosen last in this tab, for the next receipt. */
export function rememberedAccounts(): Chip[] {
  let values = kept;
  try {
    const s = globalThis.sessionStorage?.getItem(KEY);
    if (s) { const parsed: unknown = JSON.parse(s); if (Array.isArray(parsed)) values = parsed.filter((x): x is string => typeof x === 'string'); }
  } catch { /* the page's own copy */ }
  return values.map((value) => ({ field: ACCOUNT, value }));
}

export function rememberAccounts(chips: readonly Chip[]): void {
  kept = chips.filter((c) => c.field === ACCOUNT).map((c) => c.value);
  try { globalThis.sessionStorage?.setItem(KEY, JSON.stringify(kept)); } catch { /* kept for this page */ }
}
