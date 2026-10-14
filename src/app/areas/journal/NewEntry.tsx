/**
 * A new entry by hand (the add button and N), or a correction of a filed one: date, Soll, Haben,
 * amount in CHF, VAT code and text, booked in the open period. A correction names the filed
 * quarter it corrects, so the Korrekturabrechnung (0535) declares it.
 */
import { useRef, useState } from 'react';
import { localToday, parsePeriod, parseSwissDate } from '../../../accounting/periods.js';
import { lookupVatCode } from '../../../accounting/vat-codes.js';
import type { RouteOf } from '../../shell/route.js';
import { getAccountMap } from '../../lib/accounts.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { at } from '../receipts/view.js';
import { createEntry } from './actions.js';
import { AccountField } from './AccountField.js';
import { VatCodeList } from './Detail.js';
import { listed, setUi, useUi } from './state.js';
import { baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'journal'>>;

const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) && s.trim() ? n : null; };

export function NewEntry(props: Props) {
  const { books, nav } = props;
  const s = useUi();
  const form = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState('');
  if (s.overlay?.kind !== 'new') return null;
  const d = s.overlay.draft;
  const close = () => setUi({ overlay: null });
  const filed = d.corrects && parsePeriod(d.corrects, localToday());

  async function book() {
    const f = Object.fromEntries(new FormData(form.current!)) as Record<string, string>;
    const date = parseSwissDate(f.date);
    const closed = books.config?.closedThrough;
    const accounts = getAccountMap();
    const amount = parseAmount(f.amount);
    const [dr, cr, vat, text] = [f.accountDebit.trim(), f.accountCredit.trim(), f.vatCode.trim(), f.description.trim()];
    const problem = !date ? t('journal.errDate')
      : closed && date <= closed ? t('journal.errFiledDate', { date: formatDate(closed) })
      : [dr, cr].find((n) => n && !accounts[n]) ? t('journal.errAccount', { account: [dr, cr].find((n) => n && !accounts[n])! })
      : !dr && !cr ? t('journal.errNoAccount')
      : vat && !lookupVatCode(vat) ? t('journal.errVat', { code: vat })
      : !amount ? t('journal.errAmount')
      : !text ? t('journal.errText')
      : '';
    if (problem) { setErr(problem); return; }
    close();
    const entry = await createEntry(nav, { date: date!, accountDebit: dr, accountCredit: cr, amount: amount!, description: text, ...(vat && { vatCode: vat }), ...(d.corrects && { corrects: d.corrects }) });
    if (!entry) return;
    listed.pending = entry.id;
    nav.go(at({ area: 'journal', id: entry.id }, entry.date, props.period));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); book(); }
  }

  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={close} />
      <div className="palette jnew" role="dialog" aria-label={filed ? t('journal.correctionTitle') : t('journal.addTitle')}>
        <div className="ctx">
          <div><span className="lbl">{filed ? t('journal.correctionTitle') : t('journal.addTitle')}</span>{filed ? t('journal.correctionHint', { filed: periodName(filed) }) : t('journal.addHint')}</div>
        </div>
        <form ref={form} className="form" autoComplete="off" onKeyDown={onKeyDown} onSubmit={(e) => { e.preventDefault(); book(); }}>
          <div className="two">
            <label>{t('journal.field.date')}<input className="mono" name="date" defaultValue={formatDate(d.date ?? localToday())} autoFocus /></label>
            <label>{t('journal.amountIn', { currency: baseCurrency() })}<input className="mono" name="amount" defaultValue={d.amount ? fmt(d.amount) : ''} style={{ textAlign: 'right' }} /></label>
          </div>
          <div className="two">
            <AccountField name="accountDebit" label={t('journal.field.accountDebit')} defaultValue={d.accountDebit ?? ''} />
            <AccountField name="accountCredit" label={t('journal.field.accountCredit')} defaultValue={d.accountCredit ?? ''} />
          </div>
          <div className="two">
            <label>{t('journal.field.vatCode')}<input className="mono" name="vatCode" defaultValue={d.vatCode ?? ''} list="vat-codes" /></label>
            <span />
          </div>
          <label>{t('journal.field.description')}<input name="description" defaultValue={d.description ?? ''} /></label>
          <VatCodeList />
          <div className="err" role="alert">{err}</div>
          <div className="dacts">
            <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')} <span className="k">{t('codes.escKey')}</span></button>
            <button type="submit" className="btn primary">{t('journal.book')} <span className="k">↵</span></button>
          </div>
        </form>
      </div>
    </>
  );
}
