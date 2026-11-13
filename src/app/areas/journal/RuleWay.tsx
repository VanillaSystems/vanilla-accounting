/**
 * The faster way than one form per payment (#344, #383): a rule for payments of this kind, started
 * from this one right under the hand-booking form (src/saving/hand-rule.ts), with what the form
 * holds (the account, the VAT, a private share on the owner's account), so nothing typed is lost.
 * Its card shows every payment it would book before anything is kept; keeping it books them at
 * once, and the person stays where she was. It says how many unbooked payments are of the kind.
 */
import { useState } from 'react';
import type { HandStart } from '../../../saving/hand-rule.js';
import { patternText } from '../../../booking/rules.js';
import { ownerAccount } from '../../../accounting/bank-accounts.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { RuleFromPayment, type HandSeed } from '../company/RulesSection.js';

const parse = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/**
 * What the hand form holds now, for the rule: the account and VAT of its first line on the side
 * opposite the bank, and, with a line on the owner's account, her share of the payment in percent.
 */
export function seedOf(form: HTMLFormElement | null, other: 'accountDebit' | 'accountCredit' | undefined, owner: string | undefined): HandSeed {
  if (!form || !other) return {};
  const data = new FormData(form);
  const keys = [...data.keys()].filter((k) => k.startsWith(`${other}-`)).map((k) => k.slice(other.length + 1));
  const lines = keys.map((k) => ({ account: String(data.get(`${other}-${k}`) ?? '').trim(), vat: String(data.get(`vatCode-${k}`) ?? '').trim(), amount: Math.abs(parse(String(data.get(`amount-${k}`) ?? ''))) }));
  const business = lines.find((l) => l.account && l.account !== owner);
  const own = owner ? lines.filter((l) => l.account === owner).reduce((s, l) => s + l.amount, 0) : 0;
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const share = own && total && business ? Math.round((own / total) * 1000) / 10 : 0;
  return { ...(business?.account ? { account: business.account } : {}), ...(business?.vat ? { vat: business.vat } : {}), ...(share > 0 && share < 100 ? { share: String(share) } : {}) };
}

export function RuleWay({ nav, payment, start, form, other }: { nav: Nav; payment: string; start: HandStart; form(): HTMLFormElement | null; other?: 'accountDebit' | 'accountCredit' }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState<{ by?: 'text'; seed: HandSeed }>();
  if (start.rule) return null;
  if (open) return <RuleFromPayment nav={nav} payment={payment} by={open.by} seed={open.seed} onClose={() => setOpen(undefined)} />;
  const n = start.similar ?? 1;
  const what = start.match.kind === 'text' ? patternText(start.match.text) : start.name;
  const go = (by?: 'text') => setOpen({ by, seed: seedOf(form(), other, ws ? ownerAccount(ws).split(' ')[0] : undefined) });
  return (
    <p className="pbr" data-testid="task-make-rule" data-similar={n}>
      <span>{n > 1 ? t('journal.byHand.ruleMany', { n, what }) : t('journal.byHand.ruleOne')}</span>{' '}
      <button type="button" className="btn ghost" data-act="rule-start" onClick={() => go()}>{n > 1 ? t('journal.byHand.ruleManyGo', { n }) : t('journal.byHand.ruleOneGo')}</button>
      {start.wider ? (
        <span data-testid="task-make-rule-wider" data-similar={start.wider.similar}>
          <button type="button" className="linkbtn golink" data-act="rule-start-wider" onClick={() => go('text')}>{t('journal.byHand.ruleWider', { n: start.wider.similar, text: start.wider.text })}</button>
        </span>
      ) : null}
    </p>
  );
}
