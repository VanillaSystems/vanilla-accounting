/**
 * What the app knows that the setup conversation shows (docs/0.4.0/onboarding.md): the company as
 * the setup form saved it, its bank accounts, the sources switched on, the opening balances, and the
 * business partners sorted by how the books booked them. The server reads them
 * (src/server/routes/onboarding.ts); the conversation's cards are drawn from them by code, so the
 * first turn needs no AI. Pure.
 */
import type { Address } from '../invoices/model.js';
import type { LegalForm } from '../workspace/setup.js';
import type { VatSetup } from '../workspace/vat-setup.js';
import type { SetupProgress, TopicStates } from './model.js';

export interface SetupFacts {
  /** Today, YYYY-MM-DD, and the books' open year, YYYY. */
  today: string;
  year: string;
  company: { name: string; uid: string; owner: string; legalForm?: LegalForm; address?: Address; vat: VatSetup };
  banks: Array<{ label: string; bank: string; currency: string; account: string; iban?: string }>;
  /** The sources switched on, with their label in each language they name. */
  sources: Array<{ id: string; label: { en: string } & Record<string, string> }>;
  /** The open year's opening balances, by account. */
  opening: Array<{ account: string; name: string; amount: number }>;
  closedThrough?: string;
  books: { payments: number; receipts: number; entries: number };
  partners: PartnerBins;
  /** Rules the company keeps (Firma › Regeln), switched on. */
  rules: number;
}

/** One partner always booked the same way: what a rule would book. */
export interface ClearPartner { id: string; name: string; n: number; account: string; accountName: string; vat?: string; sum: number }
/** One partner booked on several accounts: how often on each, the most first. */
export interface MixedPartner { id: string; name: string; n: number; parts: Array<{ account: string; accountName: string; vat?: string; n: number }> }

/**
 * The open year's partners in the prototype's three bins: clear (booked at least CLEAR_MIN times,
 * always on one account with one code), mixed (on more than one account or code), rare (fewer
 * bookings, always the same way). `ruled`: partners that have a rule already, left out of the bins.
 */
export interface PartnerBins { clear: ClearPartner[]; mixed: MixedPartner[]; rare: Array<{ id: string; name: string; n: number }>; ruled: number }

export const CLEAR_MIN = 4;

export interface BinInput {
  partners: ReadonlyArray<{ id: string; name: string; entries: readonly string[]; rules: number }>;
  entries: ReadonlyArray<{ id: string; accountDebit: string; accountCredit: string; amount: number; vatCode?: string }>;
  /** The ledger accounts of the bank accounts: the side of a booking that is not what it was for. */
  bankAccounts: ReadonlySet<string>;
  accountName(n: string): string;
}

/** The account a booking was for: the side that is no bank account (the debit when neither is). */
const purposeOf = (e: BinInput['entries'][number], banks: ReadonlySet<string>) => (banks.has(e.accountDebit) && !banks.has(e.accountCredit) ? e.accountCredit : e.accountDebit);

export function partnerBins(input: BinInput): PartnerBins {
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const out: PartnerBins = { clear: [], mixed: [], rare: [], ruled: 0 };
  for (const p of input.partners) {
    const own = p.entries.flatMap((id) => byId.get(id) ?? []);
    if (!own.length) continue;
    if (p.rules) { out.ruled++; continue; }
    const counts = new Map<string, { account: string; vat?: string; n: number }>();
    for (const e of own) {
      const account = purposeOf(e, input.bankAccounts);
      const key = `${account}|${e.vatCode ?? ''}`;
      const c = counts.get(key) ?? { account, ...(e.vatCode ? { vat: e.vatCode } : {}), n: 0 };
      c.n++;
      counts.set(key, c);
    }
    const ways = [...counts.values()];
    if (ways.length > 1) {
      const parts = ways.sort((a, b) => b.n - a.n || a.account.localeCompare(b.account)).map((w) => ({ ...w, accountName: input.accountName(w.account) }));
      out.mixed.push({ id: p.id, name: p.name, n: own.length, parts });
    } else if (own.length >= CLEAR_MIN) {
      const { account, vat } = ways[0];
      const sum = Math.round(own.reduce((s, e) => s + Math.abs(e.amount), 0) * 100) / 100;
      out.clear.push({ id: p.id, name: p.name, n: own.length, account, accountName: input.accountName(account), ...(vat ? { vat } : {}), sum });
    } else out.rare.push({ id: p.id, name: p.name, n: own.length });
  }
  const most = <T extends { n: number; name: string }>(a: T, b: T) => b.n - a.n || a.name.localeCompare(b.name, 'de');
  out.clear.sort(most); out.mixed.sort(most); out.rare.sort(most);
  return out;
}

/**
 * GET /api/onboarding. `firstStart`: an empty workspace never set up, which opens the setup by
 * itself. `facts`: what the app knows that the conversation's cards show (src/onboarding/facts.ts).
 */
export interface SetupView { progress: SetupProgress; firstStart: boolean; facts: SetupFacts; states: TopicStates }
