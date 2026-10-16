/**
 * Firma › Regeln as data: every rule of the workspace in plain words, where it came from, how
 * often it applied, and what the person can do with it. Browser-safe; the words come from the
 * dictionary the caller passes (t in the app, a fixed one in a test).
 */
import { ruleWords, type RuleNames, type RuleRefusal, type RuleWords } from '../../../booking/rules.js';
import type { RuleRow } from '../../../booking/rule-book.js';
import type { RulesView } from '../../../saving/rules.js';

export interface RuleLine {
  key: string;
  row: RuleRow;
  /** The rule in one line: «Swisscom → Konto 6510 Telefon» with its VAT code; a note as written. */
  line: string;
  /** The app carries it out (a rule switched off too); a note or a broken rule it does not. */
  acts: boolean;
  applied: number;
  last?: string;
  /** The payments it held to ask about first (an ask rule). */
  asked: number;
}

/** The names a rule's words use, from the view. */
export function namesOf(view: Pick<RulesView, 'names' | 'currency'>, money: (n: number) => string): RuleNames {
  return {
    account: (n) => view.names.accounts[n],
    business: (id) => view.names.businesses[id],
    payer: (key) => view.names.payers?.[key],
    money: (n) => `${view.currency} ${money(n)}`,
  };
}

/** One rule row in plain words. */
export function lineOf(row: RuleRow, names: RuleNames, w: RuleWords): string {
  if (row.kind === 'rule' && row.rule) return ruleWords({ rule: row.rule, ...(row.business ? { business: row.business } : {}) }, names, w).line;
  if (row.note) {
    const who = row.business ? `${names.business(row.business) ?? row.business}: ` : '';
    return `${who}${row.note.when} → ${row.note.then}`;
  }
  return row.id;
}

/** Every rule of the view, the ones the app carries out first, each group in file order. */
export function ruleLines(view: RulesView, w: RuleWords, money: (n: number) => string): RuleLine[] {
  const names = namesOf(view, money);
  const lines = view.rules.map((r): RuleLine => ({
    key: `${r.file}#${r.step}#${r.id}`, row: r, line: lineOf(r, names, w), acts: r.kind === 'rule', applied: r.applied, asked: r.asked ?? 0, ...(r.last ? { last: r.last } : {}),
  }));
  return [...lines.filter((l) => l.acts), ...lines.filter((l) => !l.acts)];
}

/** The dictionary key and values that say why a rule cannot be carried out. */
export function refusalKey(r: RuleRefusal): { key: `rules.refuse.${RuleRefusal['code']}`; vars: Record<string, string> } {
  return { key: `rules.refuse.${r.code}`, vars: 'params' in r ? r.params as Record<string, string> : {} };
}
