/**
 * A booking's reporting dimensions (#127) as form fields: one per dimension the firm declares,
 * offering its active values and the values bookings already carry; a value not listed is a new
 * one, kept as typed. Nothing shows for a firm without dimensions.
 */
import { offeredValues, type Dimension, type Tags } from '../../../books/tags.js';
import type { JournalEntry } from '../../../types/index.js';
import { t } from '../../i18n/index.js';

/** The field of dimension `id` (with a line's suffix in a form of several lines). */
export const tagField = (id: string, suffix = '') => `tag:${id}${suffix}`;

/** The tags a form holds: every non-empty field of a declared dimension. */
export function tagsOfForm(form: FormData, dimensions: readonly Dimension[], suffix = ''): Tags | undefined {
  const tags = Object.fromEntries(dimensions.map((d) => [d.id, String(form.get(tagField(d.id, suffix)) ?? '').trim()]).filter(([, v]) => v));
  return Object.keys(tags).length ? tags : undefined;
}

export function TagFields({ dimensions, entries, tags, suffix = '', readOnly, onPick }: {
  dimensions: readonly Dimension[];
  /** The books' entries: the values they carry are offered too. */
  entries: readonly JournalEntry[];
  tags?: Tags;
  suffix?: string;
  readOnly?: boolean;
  /** A value picked from the list: the form saves as when a field is left. */
  onPick?(): void;
}) {
  if (!dimensions.length) return null;
  return (
    <div className="tags" data-testid="tag-fields">
      {dimensions.map((d) => {
        const list = `tags-${d.id}${suffix}`;
        const offered = offeredValues(d, entries);
        return (
          <label key={d.id} data-dimension={d.id}>{d.label}
            <input
              name={tagField(d.id, suffix)}
              defaultValue={tags?.[d.id] ?? ''}
              list={readOnly ? undefined : list}
              readOnly={readOnly}
              placeholder={readOnly ? undefined : t('tags.none')}
              onInput={(e) => { if (onPick && offered.some((v) => v.value === e.currentTarget.value)) onPick(); }}
            />
            {!readOnly && <datalist id={list}>{offered.map((v) => <option key={v.value} value={v.value}>{v.label ?? ''}</option>)}</datalist>}
          </label>
        );
      })}
    </div>
  );
}
