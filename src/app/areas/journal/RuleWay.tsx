/**
 * The faster way than one form per payment (#344, #383): a rule for payments of this kind, started
 * from this one right under the hand-booking form (src/saving/hand-rule.ts), with what the form
 * holds (rule-seed.ts: the account, a VAT she typed or a receipt gave, a private share on the
 * owner's account), so nothing typed is lost. Its card shows every payment it would book before
 * anything is kept; keeping it books them at once, and the person stays where she was. It says how
 * many unbooked payments are of the kind.
 */
import { useState } from 'react';
import type { HandStart } from '../../../saving/hand-rule.js';
import type { DraftLine } from '../../../accounting/manual-booking.js';
import { patternText } from '../../../booking/rules.js';
import { ownerAccount } from '../../../accounting/bank-accounts.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { RuleFromPayment } from '../company/RulesSection.js';
import { seedOf, type HandSeed } from './rule-seed.js';

export function RuleWay({ nav, payment, start, form, lines, other }: { nav: Nav; payment: string; start: HandStart; form(): HTMLFormElement | null; lines: readonly DraftLine[]; other?: 'accountDebit' | 'accountCredit' }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState<{ by?: 'text'; seed: HandSeed }>();
  if (start.rule) return null;
  if (open) return <RuleFromPayment nav={nav} payment={payment} by={open.by} seed={open.seed} onClose={() => setOpen(undefined)} />;
  const n = start.similar ?? 1;
  const what = start.match.kind === 'text' ? patternText(start.match.text) : start.name;
  const go = (by?: 'text') => {
    const el = form();
    const data = el ? new FormData(el) : undefined;
    const seed = data ? seedOf([...data.keys()], (name) => String(data.get(name) ?? ''), lines, other, ws ? ownerAccount(ws).split(' ')[0] : undefined) : {};
    setOpen({ by, seed });
  };
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
