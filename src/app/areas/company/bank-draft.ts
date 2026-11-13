/**
 * The account a statement of an account the books lack belongs to (the drop dialog's «Ja,
 * Bankkonto hinzufügen», #401): the bank, ledger account and label its row proposes, from what the
 * statement says.
 */
import type { UnknownAccount } from '../../../types/api-error.js';
import { BANKS } from '../../../workspace/banks.js';

export type BankDraft = UnknownAccount;

/** Where the chart keeps bank accounts (Swiss KMU: 1020 Bankguthaben and the numbers after it). */
const BANK_RANGE = /^102\d$/;

/**
 * The form's bank, ledger account and label for a statement's account: the bank's short name (a
 * bank the app knows, else the first word of its name), one no account in that currency has yet;
 * the first bank account of the chart no bank account uses, else the next number after them.
 */
export function draftForm(d: BankDraft, banks: ReadonlyArray<{ bank: string; currency: string; account: string }>, chart: readonly string[]): { bank: string; account: string; label: string } {
  const name = d.bankName?.trim() ?? '';
  const known = Object.keys(BANKS).find((b) => name.toLowerCase().includes(b.toLowerCase()));
  const first = name.split(/[\s,]+/)[0] ?? '';
  const short = known ?? (/^(.{3,})bank$/i.exec(first)?.[1] ?? first);
  const taken = (b: string) => banks.some((a) => a.bank.toLowerCase() === b.toLowerCase() && a.currency === d.currency);
  let bank = short;
  for (let n = 2; bank && taken(bank); n++) bank = `${short} ${n}`;
  const used = new Set(banks.map((a) => a.account));
  const range = chart.filter((a) => BANK_RANGE.test(a)).sort();
  const free = range.find((a) => !used.has(a));
  const last = Math.max(1019, ...[...used, ...range].filter((a) => BANK_RANGE.test(a)).map(Number));
  const account = free ?? (last < 1029 ? String(last + 1) : '');
  return { bank, account, label: name || (bank ? `${bank} ${d.currency}` : '') };
}
