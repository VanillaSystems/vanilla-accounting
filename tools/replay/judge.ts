/**
 * What the comparison (compare.ts) needs from the books and the VAT engine: a code as the return
 * sees it, and the lines of refs of no payment, where a payment's line may lie under another ref.
 */
import type { JournalEntry } from '../../src/types/index.js';
import { vat } from '../../src/engines/index.js';
import { canonical, Pool, WRONG_KINDS, type CompareOptions, type WrongKind } from './compare.js';
import type { Line } from './key.js';

/**
 * A code as the period's return sees it: '' for one whose line moves no figure (a zero rate on a
 * purchase), else the code. Asked of the VAT engine with a line of 100 on the period's first day.
 */
export function returnCodeKey(period: string, day: string): (code: string) => string {
  const seen = new Map<string, string>();
  return (code) => {
    let k = seen.get(code);
    if (k === undefined) {
      const line = { id: 'probe', transactionRef: 'probe', date: day, accountDebit: '6000', accountCredit: '1000', amount: 100, vatCode: code } as JournalEntry;
      let moves = true;
      try {
        const z = (vat().figures([line], period as never, []) as unknown as { ziffern: Record<string, number> }).ziffern;
        moves = Object.values(z).some((v) => v !== 0);
      } catch { /* a code the engine does not know is kept as written */ }
      k = moves ? code : '';
      seen.set(code, k);
    }
    return k;
  };
}

/** The lines dated in from–to on refs `isPayment` says no to, summed per ref as the comparison sums a payment's. */
export function poolOf(entries: readonly JournalEntry[], isPayment: (ref: string) => boolean, from: string, to: string, codeKey: (code: string) => string): Pool {
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    if (e.date < from || e.date > to || e.corrects || isPayment(e.transactionRef)) continue;
    (byRef.get(e.transactionRef) ?? byRef.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
  }
  return new Pool([...byRef.values()].flatMap((es) => canonical(es, codeKey)));
}

/**
 * What lines do to the books and the return: each account's movement (debit plus, credit minus), the
 * lines of a code whose amount is the tax itself left out (they carry the tax a gross line's code
 * carries otherwise), and the figures of the return they make. Two sets of lines that differ but do
 * the same are the same booking for the books and the return (a zero code or none, the tax on a line
 * of its own or in the gross line's code).
 */
export function effectJudge(period: string): NonNullable<CompareOptions['effect']> {
  const cents = (n: number) => Math.round(n * 100) / 100;
  const taxOnly = (code: string) => { try { return vat().codes.parse(code)?.amountIs === 'tax'; } catch { return false; } };
  const accounts = (lines: readonly Line[]) => {
    const m = new Map<string, number>();
    for (const l of lines) {
      if (l.vat && taxOnly(l.vat)) continue;
      if (l.debit) m.set(l.debit, cents((m.get(l.debit) ?? 0) + l.amount));
      if (l.credit) m.set(l.credit, cents((m.get(l.credit) ?? 0) - l.amount));
    }
    return new Map([...m].filter(([, v]) => v !== 0));
  };
  const ziffern = (lines: readonly Line[]) => {
    if (!lines.some((l) => l.vat)) return new Map<string, number>();
    const entries = lines.map((l, i) => ({ id: `l${i}`, transactionRef: 'judge', date: l.date, accountDebit: l.debit, accountCredit: l.credit, amount: l.amount, ...(l.vat ? { vatCode: l.vat } : {}) }) as JournalEntry);
    try {
      const z = (vat().figures(entries, period as never, []) as unknown as { ziffern: Record<string, number> }).ziffern;
      return new Map(Object.entries(z).filter(([, v]) => v !== 0));
    } catch { return new Map([['?', 1]]); }
  };
  // The return's figures are rounded on rate totals: a cent is no difference.
  const near = (a: Map<string, number>, b: Map<string, number>, tol: number) => [...new Set([...a.keys(), ...b.keys()])].every((k) => Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0)) <= tol + 1e-9);
  const same = (app: readonly Line[], key: readonly Line[]) => near(accounts(app), accounts(key), 0) && near(ziffern(app), ziffern(key), 0.01);
  return {
    same,
    kinds(app, key) {
      const out: WrongKind[] = [];
      const a = accounts(app);
      const k = accounts(key);
      if (!near(a, k, 0)) {
        const ka = new Set(a.keys());
        const kk = new Set(k.keys());
        const sameSet = ka.size === kk.size && [...ka].every((x) => kk.has(x));
        const nested = [...ka].every((x) => kk.has(x)) || [...kk].every((x) => ka.has(x));
        // The same accounts moved otherwise: an amount; a line more or less on accounts the other side has: a split; else an account.
        out.push(sameSet ? 'amount' : nested ? 'split' : 'account');
      }
      if (!near(ziffern(app), ziffern(key), 0.01)) out.push('vat');
      return WRONG_KINDS.filter((w) => out.includes(w));
    },
  };
}
