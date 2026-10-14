/**
 * The export dialog: one place for every export. Presets on the left (four built in, then the
 * viewer's own), the parts and their formats on the right, the period on top; ⌘↵ exports.
 * The server builds the files (POST /api/export); the static audit export has none to build.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import './export.css';
import type { Index } from '../../../types/index.js';
import { localToday, openFilingPeriod, type Period } from '../../../accounting/periods.js';
import { GROUPS, ITEMS, PRESETS, countOf, quartersIn, receiptsIn, type Format, type ItemDef, type ItemId } from '../../../export/model.js';
import { t } from '../../i18n/index.js';
import { errorText, STATIC_EXPORT } from '../../lib/api.js';
import { getAccountMap } from '../../lib/accounts.js';
import { periodName } from '../../lib/period-label.js';
import { PeriodPicker } from '../../shell/PeriodPicker.js';
import { ICONS } from '../icons.js';
import { configOf, download, ownConfig, ownPresets, periodOf, saveOwnPresets, type DialogConfig, type OwnPreset } from './state.js';
import { filing } from '../../../engines/index.js';

interface Props {
  initial: DialogConfig;
  books: Index;
  company?: string;
  /** The page's period: a button of its own in the period row. */
  page: Period;
  /** The account the reports page shows: the Kontoblatt item exports it. */
  account?: string;
  /** The quarters and years the period picker offers. */
  quarters: string[];
  toast(msg: string, undo?: () => void): void;
  onClose(): void;
}

const kb = (n: number) => (n > 1024 ? `${(n / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n))} KB`);
const itemLabel = (id: ItemId) => t(`export.item.${id}` as 'export.title');

export function ExportDialog({ initial, books, company, page, account, quarters, toast, onClose }: Props) {
  const [c, setC] = useState<DialogConfig>(initial);
  const [own, setOwn] = useState<OwnPreset[]>(ownPresets);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => dialogRef.current?.focus(), []);
  const names = getAccountMap();
  const today = localToday();
  const open = openFilingPeriod(books.config?.closedThrough, today, filing().length);
  const period = periodOf(c.period);

  const counts = useMemo(() => Object.fromEntries(ITEMS.map((i) => [i.id, countOf(i.id, books, period, names, account)])) as Record<ItemId, number>, [books, period, names, account]);
  const receiptKb = useMemo(() => receiptsIn(books, period).reduce((s, v) => s + v.r.fileSize, 0) / 1024, [books, period]);

  const year = open.token.slice(0, 4);
  const periods = [...new Set([1, 2, 3, 4].map((q) => `${year}-Q${q}`).concat([year, 'ytd', page.token, c.period]))];

  const change = (patch: Partial<DialogConfig>) => setC((x) => ({ ...x, ...patch }));
  const setFormats = (id: ItemId, formats: Format[]) => {
    const items = { ...c.items };
    if (formats.length) items[id] = formats; else delete items[id];
    change({ items, preset: null });
  };

  const summary = (() => {
    const chosen = ITEMS.filter((i) => c.items[i.id]?.length && counts[i.id]);
    const xlsx = chosen.filter((i) => c.items[i.id]!.includes('xlsx')).length;
    const book = c.oneBook && xlsx > 1;
    let files = book ? 1 : 0, size = book ? 60 : 0;
    for (const i of chosen) {
      if (i.group === 'documents') { files += counts[i.id]; size += i.id === 'receipts' ? receiptKb : counts[i.id] * 120; continue; }
      for (const f of c.items[i.id]!) {
        if (f === 'xlsx' && book) continue;
        files += 1;
        size += f === 'pdf' ? 40 : 20;
      }
    }
    if (files > 1 || (files === 1 && c.sums)) files += 1 + (c.sums ? 2 : 0);
    return { files, size };
  })();

  async function run() {
    if (busy || !summary.files || STATIC_EXPORT) return;
    setBusy(true);
    try {
      const items = Object.fromEntries(Object.entries(c.items).filter(([id]) => counts[id as ItemId]));
      const name = await download({ period: c.period, items, sums: c.sums, oneBook: c.oneBook, account });
      onClose();
      toast(t('export.saved', { name }));
    } catch (e) {
      setBusy(false);
      toast(t('export.failed', { error: errorText(e) }));
    }
  }

  function saveNamed() {
    const name = nameRef.current?.value.trim();
    if (!name) return;
    const list = [...own.filter((p) => p.name !== name), { name, period: c.period, items: c.items, sums: c.sums, oneBook: c.oneBook }];
    saveOwnPresets(list);
    setOwn(list);
    setNaming(false);
    change({ preset: name });
    toast(t('export.presetSaved', { name }));
  }

  function remove(i: number) {
    const gone = own[i];
    const list = own.filter((_, j) => j !== i);
    saveOwnPresets(list);
    setOwn(list);
    toast(t('export.presetDeleted', { name: gone.name }), () => {
      const back = [...ownPresets()];
      back.splice(i, 0, gone);
      saveOwnPresets(back);
      setOwn(back);
    });
  }

  const hint = (i: ItemDef): string => {
    const n = counts[i.id];
    if (i.id === 'vat') return n ? quartersIn(period).map((q) => periodName(periodOf(q))).join(', ') : t('export.noQuarter');
    if (i.id === 'ledger') return account === undefined ? t('export.noAccountChosen') : account === '' ? t('reports.noAccount') : `${account} ${names[account] ?? ''}`;
    if (!n) return t('export.nothingIn');
    switch (i.id) {
      case 'journal': return t('export.unit.entries', { n });
      case 'payments': return t('export.unit.payments', { n });
      case 'receiptList': return t('export.unit.receipts', { n });
      case 'ledgers': case 'chart': return t('export.unit.accounts', { n });
      case 'receipts': return `${t('export.unit.files', { n })} · ${kb(receiptKb)}`;
      case 'statements': return t('export.unit.files', { n });
      case 'filings': return t('export.unit.quarters', { n });
      default: return '';
    }
  };

  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 45%, transparent)' }} onClick={() => !busy && onClose()} />
      <div
        className="palette xdlg"
        role="dialog"
        aria-label={t('export.dialog')}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void run(); }
        }}
      >
        <div className="xhd">
          <div><span className="lbl">{t('export.title')}</span><b>{company}</b></div>
          <div className="xper" role="radiogroup" aria-label={t('export.period')}>
            {periods.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={p === c.period} className={p === c.period ? 'on' : ''} onClick={() => change({ period: p })}>{periodName(periodOf(p))}</button>
            ))}
            <button type="button" className="xcal" aria-haspopup="dialog" title={t('export.customPeriodTip')} onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}>
              {ICONS.calendar}<span>{t('export.customPeriod')}</span>
            </button>
          </div>
        </div>
        <div className="xbody">
          <nav className="xpre" aria-label={t('export.presets')}>
            <div className="gh">{t('export.presets')}</div>
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className={c.preset === p.id ? 'on' : ''} onClick={() => setC(configOf(p.id, open, page))}>
                <b>{t(`export.preset.${p.id}` as 'export.title')}</b><span>{t(`export.preset.${p.id}Note` as 'export.title')}</span>
              </button>
            ))}
            {own.length > 0 && <div className="gh">{t('export.own')}</div>}
            {own.map((p, i) => (
              <div key={p.name} className={`xown${c.preset === p.name ? ' on' : ''}`}>
                <button type="button" onClick={() => setC(ownConfig(p))}>
                  <b>{p.name}</b><span>{t('export.ownMeta', { period: periodName(periodOf(p.period)), n: Object.keys(p.items).length })}</span>
                </button>
                <button type="button" className="del" title={t('export.deletePreset')} aria-label={t('export.deletePresetNamed', { name: p.name })} onClick={() => remove(i)}>×</button>
              </div>
            ))}
          </nav>
          <div className="xcfg">
            {GROUPS.map((g) => (
              <div key={g}>
                <div className="gh">{t(`export.group.${g}` as 'export.title')}</div>
                {ITEMS.filter((i) => i.group === g).map((i) => {
                  const f = c.items[i.id] ?? [];
                  const on = f.length > 0;
                  const n = counts[i.id];
                  return (
                    <div key={i.id} className={`xrow${on ? ' on' : ''}${n ? '' : ' empty'}`}>
                      <label>
                        <input type="checkbox" checked={on} disabled={!n} onChange={(e) => setFormats(i.id, e.target.checked ? [i.formats[0]] : [])} />
                        <span>{itemLabel(i.id)}</span>
                        <small>{hint(i)}</small>
                      </label>
                      <span className="xf">
                        {i.formats.length > 1 ? i.formats.map((x) => (
                          <button
                            key={x}
                            type="button"
                            className={f.includes(x) ? 'on' : ''}
                            aria-pressed={f.includes(x)}
                            disabled={!n}
                            title={x === 'banana' ? t('export.bananaTip') : t(`export.fmt.${x}` as 'export.title')}
                            onClick={() => setFormats(i.id, f.includes(x) ? f.filter((y) => y !== x) : [...f, x])}
                          >{t(`export.fmt.${x}` as 'export.title')}</button>
                        )) : <span className="orig">{t('export.originals')}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {c.preset === 'audit' && <p className="xnote">{t('export.auditNote', { command: 'npm run build:audit' })}</p>}
            {STATIC_EXPORT && <p className="xnote">{t('export.staticOff')}</p>}
          </div>
        </div>
        <div className="xft">
          <div className="xopt">
            <label><input type="checkbox" checked={c.sums} onChange={(e) => change({ sums: e.target.checked })} /> {t('export.sums')}</label>
            <label><input type="checkbox" checked={c.oneBook} onChange={(e) => change({ oneBook: e.target.checked })} /> {t('export.oneBook')}</label>
          </div>
          <div className="xsum">
            {summary.files
              ? t('export.summary', { files: t('export.unit.files', { n: summary.files }), size: kb(summary.size), kind: summary.files > 1 ? t('export.zip') : t('export.single') })
              : t('export.nothing')}
          </div>
          {naming ? (
            <span className="xname">
              <input
                ref={nameRef}
                autoFocus
                placeholder={t('export.presetName')}
                aria-label={t('export.presetName')}
                defaultValue={c.preset && !PRESETS.some((p) => p.id === c.preset) ? c.preset : t('export.presetDefault')}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); saveNamed(); } }}
              />
              <button type="button" className="btn ghost" onClick={() => setNaming(false)}>{t('common.cancel')}</button>
              <button type="button" className="btn" onClick={saveNamed}>{t('export.savePreset')}</button>
            </span>
          ) : (
            <button type="button" className="btn ghost" disabled={!summary.files} onClick={() => setNaming(true)}>{t('export.saveAs')}</button>
          )}
          <button type="button" className="btn primary" disabled={!summary.files || busy || STATIC_EXPORT} onClick={() => void run()}>
            {busy ? t('export.busy') : <>{t('export.run')} <span className="k">⌘↵</span></>}
          </button>
        </div>
      </div>
      {picker && (
        <PeriodPicker
          anchor={picker}
          period={period}
          quarters={quarters}
          years={[...new Set(quarters.map((q) => q.slice(0, 4)))]}
          closedThrough={books.config?.closedThrough}
          onClose={() => setPicker(null)}
          onApply={(token) => { setPicker(null); change({ period: token }); }}
        />
      )}
    </>
  );
}

