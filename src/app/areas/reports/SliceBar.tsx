/**
 * Above the Erfolgsrechnung of a firm with reporting dimensions (#127): the tag values it is
 * filtered by, each a chip to take off, a list to add one (or the bookings without a value), and
 * the dimension it shows a column per value of.
 */
import { offeredValues, valueLabel, type Dimension } from '../../../books/tags.js';
import type { JournalEntry } from '../../../types/index.js';
import { t } from '../../i18n/index.js';
import { withValue, withoutValue, type Slice } from './slice.js';

/** One option of the add list: `dimension` and `value` apart by a character no id holds. */
const SEP = '\u0000';

export function SliceBar({ dimensions, slice, entries, onChange }: { dimensions: readonly Dimension[]; slice: Slice; entries: readonly JournalEntry[]; onChange(s: Slice): void }) {
  const chips = Object.entries(slice.filter).flatMap(([d, values]) => values.map((v) => ({ d, v, dim: dimensions.find((x) => x.id === d) })));
  const add = (option: string) => {
    const [d, v] = option.split(SEP);
    if (d !== undefined && v !== undefined) onChange(withValue(slice, d, v));
  };
  return (
    <div className="rslice" data-testid="slice">
      {chips.map(({ d, v, dim }) => (
        <span key={`${d}:${v}`} className="rchip" data-tag={`${d}:${v}`}>
          {dim?.label ?? d}: {v ? valueLabel(dim, v) : t('tags.without')}
          <button type="button" aria-label={t('reports.slice.remove')} title={t('reports.slice.remove')} onClick={() => onChange(withoutValue(slice, d, v))}>×</button>
        </span>
      ))}
      <label>
        <span className="sr">{t('reports.slice.add')}</span>
        <select value="" data-testid="slice-add" onChange={(e) => add(e.target.value)}>
          <option value="">{chips.length ? t('reports.slice.addMore') : t('reports.slice.add')}</option>
          {dimensions.map((d) => (
            <optgroup key={d.id} label={d.label}>
              {offeredValues(d, entries).filter((v) => !slice.filter[d.id]?.includes(v.value)).map((v) => <option key={v.value} value={`${d.id}${SEP}${v.value}`}>{v.label ?? v.value}</option>)}
              {!slice.filter[d.id]?.includes('') && <option value={`${d.id}${SEP}`}>{t('tags.without')}</option>}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="rby">{t('reports.slice.by')}
        <select value={slice.by ?? ''} data-testid="slice-by" onChange={(e) => onChange({ ...slice, ...(e.target.value ? { by: e.target.value } : { by: undefined }) })}>
          <option value="">{t('reports.slice.noColumns')}</option>
          {dimensions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      </label>
    </div>
  );
}
