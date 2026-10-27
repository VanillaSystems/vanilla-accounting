/**
 * A list's filter as chips (#211), shared by the lists: the chips (each with ×, those of one field
 * joined by «oder»), the «Filter» button with its menu of fields and values, and the search, whose
 * typed text also offers the matching values as chips. The area names its fields
 * (src/app/shell/chips.ts) and keeps the chips in the URL; this draws and edits them.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { ICONS } from '../areas/icons.js';
import { addChip, amountToken, applyChips, excluding, parseAmount, removeChip, suggestions, type Chip, type Field, type FieldWords } from './chips.js';
import { monthName } from '../lib/period-label.js';

/** The app's words for the fields (the browser's dictionary). */
export const chipWords: FieldWords = { say: (key, vars) => t(key, vars as never), monthName };

const FUNNEL = <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" /></svg>;

export interface ChipFilterProps<T> {
  fields: readonly Field<T>[];
  /** The rows the menu offers values from and counts them in. */
  rows: readonly T[];
  chips: readonly Chip[];
  onChips(chips: Chip[]): void;
  q?: string;
  onQ(q: string | undefined): void;
  searchLabel: string;
  /** The search's key hint (the list's own Kbd). */
  searchKey?: ReactNode;
}

export const chipText = <T,>(c: Chip, fields: readonly Field<T>[]): string => {
  const f = fields.find((x) => x.id === c.field);
  return f ? t('chips.chip', { field: f.label(), value: f.valueLabel(c.value) }) : c.value;
};

/** The chips of one field as one phrase: «Geschäftspartner: FedEx oder Amazon». */
export const fieldText = <T,>(field: string, chips: readonly Chip[], fields: readonly Field<T>[]): string => {
  const f = fields.find((x) => x.id === field);
  const values = chips.filter((c) => c.field === field).map((c) => f?.valueLabel(c.value) ?? c.value);
  return f ? t('chips.chip', { field: f.label(), value: values.join(` ${t('chips.or')} `) }) : values.join(', ');
};

export function ChipFilter<T>({ fields, rows, chips, onChips, q, onQ, searchLabel, searchKey }: ChipFilterProps<T>) {
  const [menu, setMenu] = useState<{ field?: string } | null>(null);
  const [typed, setTyped] = useState('');
  const [focus, setFocus] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menu && !focus) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setMenu(null); setFocus(false); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menu, focus]);

  const add = (c: Chip) => { onChips(addChip(chips, c, fields)); setMenu(null); setTyped(''); };
  const count = (c: Chip) => applyChips(rows, [c], fields).length;
  const offered = fields.filter((f) => f.input !== 'pick' || (f.options?.(rows).length ?? 0) > 0);
  const field = menu?.field ? fields.find((f) => f.id === menu.field) : undefined;
  const hits = focus && q ? suggestions(q, rows, fields, chips, 6) : [];

  return (
    <div className="chipbar" ref={box} data-testid="chipbar" onKeyDown={(e) => { if (e.key === 'Escape' && menu) { e.stopPropagation(); setMenu(null); } }}>
      {chips.map((c, i) => (
        <span key={`${c.field}_${c.value}`} className="fchipwrap">
          {i > 0 && chips[i - 1].field === c.field && <span className="or">{t('chips.or')}</span>}
          <span className="fchip" data-field={c.field} data-value={c.value}>
            <span className="fl">{fields.find((f) => f.id === c.field)?.label()}</span>
            <b>{fields.find((f) => f.id === c.field)?.valueLabel(c.value) ?? c.value}</b>
            <button type="button" className="x" aria-label={t('chips.remove', { chip: chipText(c, fields) })} onClick={() => onChips(removeChip(chips, c))}>×</button>
          </span>
        </span>
      ))}
      <span className="fchipwrap">
        <button type="button" className={`fbtn${menu ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={!!menu} data-testid="filter-button" onClick={() => setMenu(menu ? null : {})}>
          {FUNNEL}{t('chips.filter')}
        </button>
        {chips.length > 1 && <button type="button" className="fclear" onClick={() => onChips([])}>{t('chips.clear')}</button>}
      </span>
      <label className="search">
        {ICONS.search}
        <span className="sr">{searchLabel}</span>
        <input
          ref={search}
          type="search"
          placeholder={t('shell.search')}
          value={q ?? ''}
          className={q ? 'has' : ''}
          autoComplete="off"
          onFocus={() => setFocus(true)}
          onChange={(e) => onQ(e.target.value || undefined)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { onQ(undefined); setFocus(false); }
            if (e.key === 'ArrowDown' && hits[0]) { e.preventDefault(); box.current?.querySelector<HTMLButtonElement>('.fsuggest button')?.focus(); }
          }}
        />
        {searchKey}
      </label>

      {hits.length > 0 && (
        <div className="fpop fsuggest" role="menu" aria-label={t('chips.suggestions')}>
          <p className="fhead">{t('chips.suggestions')}</p>
          {hits.map(({ field: f, option: o }) => (
            <button key={`${f.id}_${o.value}`} type="button" role="menuitem" onClick={() => { add({ field: f.id, value: o.value }); onQ(undefined); setFocus(false); }}>
              <span>{t('chips.chip', { field: f.label(), value: o.label })}</span><span className="n mono">{count({ field: f.id, value: o.value })}</span>
            </button>
          ))}
        </div>
      )}

      {menu && (
        <div className="fpop" role="menu" aria-label={t('chips.filter')} data-testid="filter-menu">
          {!field ? (
            <>
              <p className="fhead">{t('chips.addField')}</p>
              {offered.map((f) => (
                <button key={f.id} type="button" role="menuitem" data-field={f.id}
                  onClick={() => { if (f.input === 'text') { setMenu(null); search.current?.focus(); } else { setTyped(''); setMenu({ field: f.id }); } }}>
                  <span>{f.label()}</span>{f.input === 'text' ? <span className="n">/</span> : <span className="n">›</span>}
                </button>
              ))}
            </>
          ) : (
            <>
              <button type="button" className="fback" onClick={() => setMenu({})}>{ICONS.left}{field.label()}</button>
              {field.input === 'pick' ? (
                <div className="fopts">
                  {(field.options?.(rows) ?? []).map((o) => {
                    const on = chips.some((c) => c.field === field.id && c.value === o.value);
                    const n = count({ field: field.id, value: o.value });
                    return (
                      <button key={o.value} type="button" role="menuitemcheckbox" aria-checked={on} className={on ? 'on' : ''} data-value={o.value}
                        onClick={() => (on ? onChips(removeChip(chips, { field: field.id, value: o.value })) : add({ field: field.id, value: o.value }))}>
                        <span>{on && ICONS.check}{o.label}</span><span className="n mono">{n}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <form className="ftyped" onSubmit={(e) => {
                  e.preventDefault();
                  const value = field.input === 'number' ? (parseAmount(typed) === undefined ? '' : amountToken(Math.abs(parseAmount(typed)!))) : typed;
                  if (value && field.test(value)) add({ field: field.id, value });
                }}>
                  <input autoFocus type={field.input === 'date' ? 'date' : 'text'} inputMode={field.input === 'number' ? 'decimal' : undefined} value={typed}
                    aria-label={field.label()} onChange={(e) => setTyped(e.target.value)} />
                  <button type="submit" className="btn primary" disabled={!typed}>{t('chips.add')}</button>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The list is empty because of its chips: which fields' chips exclude everything, each with the
 * number of rows its removal would show, and «Alle Filter entfernen» when only the combination does.
 */
export function ChipEmpty<T>({ fields, rows, chips, onChips }: { fields: readonly Field<T>[]; rows: readonly T[]; chips: readonly Chip[]; onChips(chips: Chip[]): void }) {
  const why = excluding(rows, chips, fields);
  const helps = why.without.filter((w) => w.n > 0);
  return (
    <div className="empty chipempty" data-testid="chip-empty">
      <h2>{t('chips.emptyTitle')}</h2>
      {why.alone.map((f) => <p key={f}>{t('chips.aloneNone', { chip: fieldText(f, chips, fields) })}</p>)}
      {!why.alone.length && <p>{helps.length ? t('chips.emptyText') : t('chips.together')}</p>}
      <div className="fexits">
        {helps.map((w) => (
          <button key={w.field} type="button" className="btn" data-field={w.field} onClick={() => onChips(chips.filter((c) => c.field !== w.field))}>
            {t('chips.removeShows', { chip: fieldText(w.field, chips, fields), n: w.n })}
          </button>
        ))}
        <button type="button" className="btn" onClick={() => onChips([])}>{t('chips.clearAll')}</button>
      </div>
    </div>
  );
}
