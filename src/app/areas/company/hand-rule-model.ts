/**
 * The form of a rule made by hand in Firma › Regeln as data (r8k-4): what the person typed, and
 * the rule it makes, or what is still missing. Browser-safe; the server checks the rule as the
 * app would carry it out (src/saving/hand-rule.ts).
 */
import type { HandRule, HandStart } from '../../../saving/hand-rule.js';

export interface HandForm {
  match: 'business' | 'payer' | 'text';
  business: string;
  payer: string;
  text: string;
  direction: '' | 'in' | 'out';
  /** Amounts as typed: «1'000.50», «500». */
  over: string;
  under: string;
  account: string;
  /** '' books without a VAT code. */
  vat: string;
  /** Per reporting dimension the value typed; '' none (#127). */
  tags: Record<string, string>;
  /** The owner's share in percent as typed; '' none. */
  share: string;
  /** The share booked as own use, the input tax corrected. */
  ownUse: boolean;
}

export type Missing = 'business' | 'payer' | 'text' | 'amount' | 'account' | 'share';

export const emptyForm = (start?: HandStart | null): HandForm => ({
  match: start?.match.kind ?? 'text',
  business: start?.match.kind === 'business' ? start.match.id : '',
  payer: start?.match.kind === 'payer' ? start.match.payer : '',
  text: start?.match.kind === 'text' ? start.match.text : '',
  direction: start?.direction ?? '',
  over: '', under: '', account: '', vat: '', tags: {}, share: '', ownUse: false,
});

/** An amount as typed, or undefined when the field is empty; NaN when it is no amount. */
function amountOf(s: string): number | undefined {
  const v = s.replace(/['’\s]/g, '').replace(',', '.');
  if (!v) return undefined;
  const n = /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  return n;
}

/** The rule the form makes, or the first field it still needs. */
export function handRuleOf(f: HandForm): { ok: true; rule: HandRule } | { ok: false; missing: Missing } {
  const value = f.match === 'business' ? f.business.trim() : f.match === 'payer' ? f.payer.trim() : f.text.trim();
  if (!value) return { ok: false, missing: f.match };
  const over = amountOf(f.over);
  const under = amountOf(f.under);
  if (Number.isNaN(over) || Number.isNaN(under) || (over !== undefined && under !== undefined && over >= under)) return { ok: false, missing: 'amount' };
  if (!f.account.trim()) return { ok: false, missing: 'account' };
  const share = amountOf(f.share.replace(/\s*%$/, ''));
  if (Number.isNaN(share) || (share !== undefined && (share <= 0 || share >= 100))) return { ok: false, missing: 'share' };
  const match = f.match === 'business' ? { kind: 'business' as const, id: value } : f.match === 'payer' ? { kind: 'payer' as const, payer: value } : { kind: 'text' as const, text: value };
  return {
    ok: true,
    rule: {
      match,
      ...(f.direction ? { direction: f.direction } : {}),
      ...(over !== undefined || under !== undefined ? { amount: { ...(over !== undefined ? { over } : {}), ...(under !== undefined ? { under } : {}) } } : {}),
      account: f.account.trim().split(/\s/)[0],
      vat: f.vat || null,
      ...(share !== undefined ? { private: { share, ...(f.ownUse ? { ownUse: true } : {}) } } : {}),
      ...((tags) => (Object.keys(tags).length ? { tags } : {}))(Object.fromEntries(Object.entries(f.tags).map(([d, v]) => [d, v.trim()]).filter(([, v]) => v))),
    },
  };
}
