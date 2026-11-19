/**
 * Firma › Rechnungslayout › Mahnwesen (spec docs/specs/invoicing.md 4.4.7): the Mahnstufen as a list
 * (name, days to pay, an optional fee, an automatic reminder «N Tage nach Fälligkeit», texts per
 * language) and default interest, off unless switched on. Saved as one block in belege.workspace.yaml
 * (invoicing.dunning); a Mahnung sent keeps what it printed, so a level may change or go any time.
 */
import { useEffect, useState } from 'react';
import type { DunningLevel, DunningSettings, DunningTexts, InvoiceLanguage } from '../../../invoices/model.js';
import { DEFAULT_DUNNING, MAX_LEVELS } from '../../../workspace/dunning.js';
import type { Device } from '../../../workspace/device.js';
import { TEXTS } from '../../../invoices/texts.js';
import type { CompanyInfo } from '../../../books/company.js';
import { api, errorText } from '../../lib/api.js';
import { reloadWorkspace } from '../../hooks/use-workspace.js';
import { invoicing } from '../../../engines/index.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { AsyncButton } from '../../shell/AsyncButton.js';

const LANGS: InvoiceLanguage[] = ['de', 'fr', 'it', 'en'];
const TEXT_KEYS = ['title', 'intro', 'closing', 'mailSubject', 'mailBody'] as const;
const num = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));

export function DunningSection({ ws, nav, canEdit }: { ws: CompanyInfo; nav: Nav; canEdit: boolean }) {
  const dunning = ws.invoicing?.dunning ?? DEFAULT_DUNNING;
  const [lang, setLang] = useState<InvoiceLanguage>('de');
  const [open, setOpen] = useState<number | null>(null);
  const offered = invoicing().interest;
  // This computer: the automatic reminders run only on the one they were switched on (decision 7.4).
  const [here, setHere] = useState<Device>();
  useEffect(() => { api.dunningDevice().then((x) => setHere(x.here), () => setHere(undefined)); }, []);
  const auto = dunning.levels.some((l) => l.auto);
  async function save(next: DunningSettings | (Omit<DunningSettings, 'device'> & { device: 'here' }), done: string): Promise<boolean> {
    try {
      await api.patchWorkspace({ invoicing: { dunning: next as DunningSettings } });
      reloadWorkspace();
      nav.toast(done);
      return true;
    } catch (e) { nav.toast(errorText(e)); return false; }
  }
  const setLevel = (k: number, change: Partial<DunningLevel> | ((l: DunningLevel) => DunningLevel)) => {
    const levels = dunning.levels.map((l, i) => (i !== k ? l : typeof change === 'function' ? change(l) : { ...l, ...change }));
    return save({ ...dunning, levels }, t('dunning.set.saved', { name: levels[k]!.name }));
  };
  const without = <K extends keyof DunningLevel>(l: DunningLevel, key: K): DunningLevel => { const { [key]: _, ...rest } = l; return rest as DunningLevel; };
  const setText = (k: number, key: (typeof TEXT_KEYS)[number], value: string) => setLevel(k, (l) => {
    const texts: Partial<Record<InvoiceLanguage, DunningTexts>> = { ...(l.texts ?? {}) };
    const own: DunningTexts = { ...(texts[lang] ?? {}) };
    if (value.trim()) own[key] = value; else delete own[key];
    if (Object.keys(own).length) texts[lang] = own; else delete texts[lang];
    return Object.keys(texts).length ? { ...l, texts } : without(l, 'texts');
  });
  const move = (k: number, by: -1 | 1) => {
    const levels = [...dunning.levels];
    [levels[k], levels[k + by]] = [levels[k + by]!, levels[k]!];
    return save({ ...dunning, levels }, t('dunning.set.moved'));
  };
  const L = TEXTS[lang];
  return (
    <div className="lkf lkdunning" data-testid="dunning-settings">
      <div className="lkr top"><span>{t('dunning.set.title')}</span><span className="m">{t('dunning.set.hint')}</span></div>
      {/* One block per level, two lines each: the column beside the sample sheet is narrow. */}
      <ol className="lkdun">
        {dunning.levels.map((l, k) => (
          <li key={`${k}-${l.name}`} data-level={k + 1}>
            <div className="lkdrow">
              <span className="mono lkdk">{k + 1}</span>
              <input name="name" defaultValue={l.name} disabled={!canEdit} aria-label={t('dunning.set.name')} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== l.name) void setLevel(k, { name: v }); }} />
              <label><input name="days" className="mono" inputMode="numeric" defaultValue={String(l.days)} disabled={!canEdit} aria-label={t('dunning.set.days')} onBlur={(e) => { const v = num(e.target.value); if (v !== undefined && Number.isInteger(v) && v >= 0 && v !== l.days) void setLevel(k, { days: v }); }} /> {t('dunning.set.daysShort')}</label>
              <label>{t('dunning.set.fee')} <input name="fee" className="mono" inputMode="decimal" defaultValue={l.fee ? String(l.fee) : ''} placeholder="0.00" disabled={!canEdit} aria-label={t('dunning.set.fee')} onBlur={(e) => { const v = num(e.target.value); if ((v ?? 0) !== (l.fee ?? 0) && (v === undefined || v >= 0)) void setLevel(k, (x) => (v ? { ...x, fee: v } : without(x, 'fee'))); }} /></label>
            </div>
            <div className="lkdrow sub">
              <label className="lkauto"><input type="checkbox" name="auto" checked={!!l.auto} disabled={!canEdit} onChange={(e) => void setLevel(k, (x) => (e.target.checked ? { ...x, auto: { afterDays: 5 } } : without(x, 'auto')))} />
                {l.auto ? <>{t('dunning.set.auto')} <input name="afterDays" className="mono" inputMode="numeric" defaultValue={String(l.auto.afterDays)} disabled={!canEdit} aria-label={t('dunning.set.afterDays')} onBlur={(e) => { const v = num(e.target.value); if (v !== undefined && Number.isInteger(v) && v >= 0 && v !== l.auto?.afterDays) void setLevel(k, { auto: { afterDays: v } }); }} /> {t('dunning.set.afterDue')}</> : t('dunning.set.byHand')}
              </label>
              <span className="lkacts">
                <button type="button" className="quiet2" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>{t('dunning.set.texts')}</button>
                {canEdit && k > 0 && <AsyncButton type="button" className="quiet2" aria-label={t('dunning.set.up', { name: l.name })} onClick={() => move(k, -1)}>↑</AsyncButton>}
                {canEdit && dunning.levels.length > 1 && <AsyncButton type="button" className="quiet2" aria-label={t('dunning.set.remove', { name: l.name })} onClick={() => save({ ...dunning, levels: dunning.levels.filter((_, i) => i !== k) }, t('dunning.set.removed', { name: l.name }))}>×</AsyncButton>}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {open !== null && dunning.levels[open] && (
        <div className="lkf lkmail" key={`${open}-${lang}`} data-testid="dunning-texts">
          <div className="lkr"><span>{t('dunning.set.textsOf', { name: dunning.levels[open]!.name })}</span>
            <span className="seg2" role="radiogroup" aria-label={t('invoiceLayout.language')}>
              {LANGS.map((x) => <button key={x} type="button" role="radio" aria-checked={x === lang} className={x === lang ? 'on' : ''} onClick={() => setLang(x)}>{x.toUpperCase()}</button>)}
            </span>
          </div>
          {TEXT_KEYS.map((key) => {
            const own = dunning.levels[open]!.texts?.[lang]?.[key] ?? '';
            const fallback = key === 'title' ? dunning.levels[open]!.name : key === 'intro' ? L.reminderIntro(open + 1, '{number}', '{date}', '{due}', '{previous}', dunning.levels[open]!.days) : key === 'closing' ? L.reminderClosing : key === 'mailSubject' ? L.mailSubject : L.mailBody;
            const area = key === 'intro' || key === 'closing' || key === 'mailBody';
            const props = { name: key, defaultValue: own, placeholder: fallback, disabled: !canEdit, onBlur: (e: { target: { value: string } }) => { if (e.target.value !== own) void setText(open, key, e.target.value); } };
            return <label key={key} className={`lkr${area ? ' top' : ''}`}><span>{t(`dunning.set.text.${key}`)}</span>{area ? <textarea rows={key === 'mailBody' ? 5 : 3} {...props} /> : <input {...props} />}</label>;
          })}
          <p className="m ivhint">{t('dunning.set.placeholders', { number: '{number}', date: '{date}', due: '{due}', days: '{days}', previous: '{previous}', document: '{document}', company: '{company}' })}</p>
        </div>
      )}
      {canEdit && (
        <div className="lkuadd">
          {dunning.levels.length < MAX_LEVELS
            ? <AsyncButton type="button" className="btn ghost" data-act="dunning-add" onClick={() => save({ ...dunning, levels: [...dunning.levels, { name: t('dunning.set.newName', { n: dunning.levels.length + 1 }), days: 10 }] }, t('dunning.set.added'))}>{t('dunning.set.add')}</AsyncButton>
            : <span className="m" data-testid="dunning-max">{t('dunning.set.max', { max: MAX_LEVELS })}</span>}
        </div>
      )}
      {auto && (
        <p className="m ivhint" data-testid="dunning-device">
          {!dunning.device ? t('dunning.set.deviceNone') : here && dunning.device.id === here.id ? t('dunning.set.deviceHere', { name: dunning.device.name }) : t('dunning.set.deviceOther', { name: dunning.device.name })}
          {canEdit && here && dunning.device?.id !== here.id && <> <AsyncButton type="button" className="quiet2" data-act="dunning-device-here" onClick={() => save({ ...dunning, device: 'here' }, t('dunning.set.deviceMoved', { name: here.name }))}>{t('dunning.set.deviceMove')}</AsyncButton></>}
        </p>
      )}
      <div className="lkr top">
        <span>{t('dunning.set.interest')}</span>
        <span className="lkinterest">
          <label><input type="checkbox" name="interest" checked={!!dunning.interest} disabled={!canEdit} onChange={(e) => {
            const { interest: _, ...rest } = dunning;
            void save(e.target.checked ? { ...rest, interest: { rate: offered?.rate ?? 5 } } : rest, t(e.target.checked ? 'dunning.set.interestOn' : 'dunning.set.interestOff'));
          }} />{dunning.interest ? null : ` ${t('dunning.set.interestNone')}`}</label>
          {dunning.interest && <><input name="rate" className="mono" inputMode="decimal" defaultValue={String(dunning.interest.rate)} disabled={!canEdit} aria-label={t('dunning.set.interestRate')} onBlur={(e) => { const v = num(e.target.value); if (v && v > 0 && v !== dunning.interest?.rate) void save({ ...dunning, interest: { ...dunning.interest!, rate: v } }, t('dunning.set.interestOn')); }} /> {t('dunning.set.interestRate')}</>}
          {dunning.interest && <span className="m">{t('dunning.set.interestHint', { account: dunning.interest.account ?? offered?.account ?? '' })}</span>}
        </span>
      </div>
    </div>
  );
}
