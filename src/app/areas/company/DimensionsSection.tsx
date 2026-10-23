/**
 * Firma › Dimensionen (#127): the reporting dimensions bookings may carry a tag of (a project, a
 * cost centre, a location), each with the values it offers. A dimension is added with its name,
 * renamed, and taken out while no booking carries it; a value is added, named, or set aside
 * (inactive: no longer offered, the bookings that carry it keep it). Written to belege.workspace.yaml.
 */
import { useState, type FormEvent } from 'react';
import { DIMENSION_ID, offeredValues, tagValue, usesOf, type Dimension } from '../../../books/tags.js';
import type { JournalEntry } from '../../../types/index.js';
import { t } from '../../i18n/index.js';

/** An id from a name: «Kostenstelle» → kostenstelle; one no other dimension has. */
export function dimensionId(label: string, taken: readonly string[]): string {
  const base = (label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '') || 'dimension').slice(0, 28);
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return DIMENSION_ID.test(id) ? id : 'dimension';
}

export function DimensionsSection({ dimensions, entries, canEdit, save }: {
  dimensions: readonly Dimension[];
  entries: readonly JournalEntry[];
  canEdit: boolean;
  /** Writes the whole list; the toast names the change and takes it back. */
  save(next: Dimension[], message: string): Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const list = [...dimensions];
  const replace = (i: number, d: Dimension) => list.map((x, j) => (j === i ? d : x));

  async function add(e: FormEvent) {
    e.preventDefault();
    const label = name.trim();
    if (!label) return;
    if (await save([...list, { id: dimensionId(label, list.map((d) => d.id)), label, values: [] }], t('dimensions.added', { name: label }))) setName('');
  }

  return (
    <div className="dims" data-testid="dimensions">
      <p className="m">{t('dimensions.lead')}</p>
      {!list.length && <p data-testid="dimensions-empty">{t('dimensions.empty')}</p>}
      {list.map((d, i) => (
        <DimensionCard key={d.id} d={d} entries={entries} canEdit={canEdit}
          onSave={(next, message) => save(replace(i, next), message)}
          onRemove={() => save(list.filter((_, j) => j !== i), t('dimensions.removed', { name: d.label }))} />
      ))}
      {canEdit && (
        <form className="form inline dimadd" onSubmit={add}>
          <label>{t('dimensions.new')}<input value={name} placeholder={t('dimensions.newPlaceholder')} onChange={(e) => setName(e.target.value)} /></label>
          <button type="submit" className="btn" disabled={!name.trim()}>{t('dimensions.add')}</button>
        </form>
      )}
    </div>
  );
}

function DimensionCard({ d, entries, canEdit, onSave, onRemove }: { d: Dimension; entries: readonly JournalEntry[]; canEdit: boolean; onSave(next: Dimension, message: string): Promise<boolean>; onRemove(): void }) {
  const [value, setValue] = useState('');
  const used = usesOf(d.id, entries);
  // The values bookings carry that the list does not name yet: one click lists them.
  const unlisted = offeredValues(d, entries).filter((v) => !d.values.some((x) => x.value === v.value));
  const count = (v: string) => entries.filter((e) => e.tags?.[d.id] === v).length;
  const rename = (label: string) => { if (label.trim() && label.trim() !== d.label) void onSave({ ...d, label: label.trim() }, t('dimensions.renamed', { name: label.trim() })); };
  const addValue = async (raw: string) => {
    const v = tagValue(raw);
    if (!v || d.values.some((x) => x.value === v)) return false;
    return onSave({ ...d, values: [...d.values, { value: v, active: true }] }, t('dimensions.valueAdded', { value: v, name: d.label }));
  };
  const setValueField = (i: number, patch: { label?: string; active?: boolean }, message: string) =>
    onSave({ ...d, values: d.values.map((x, j) => (j === i ? { ...x, ...patch } : x)) }, message);

  return (
    <section className="dimcard" data-dimension={d.id}>
      <div className="dimhead">
        <input className="dimname" defaultValue={d.label} readOnly={!canEdit} aria-label={t('dimensions.name')} onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <span className="mono m">{d.id}</span>
        <span className="m">{t('common.entryCount', { n: used })}</span>
        {canEdit && (used
          ? <span className="m" title={t('dimensions.inUse', { n: used })}>{t('dimensions.cannotRemove')}</span>
          : <button type="button" className="golink" onClick={onRemove}>{t('dimensions.remove')}</button>)}
      </div>
      <div className="dimvals">
        {d.values.map((v, i) => (
          <div key={v.value} className={`dimval${v.active ? '' : ' off'}`} data-value={v.value}>
            <span className="mono">{v.value}</span>
            <input defaultValue={v.label ?? ''} placeholder={t('dimensions.valueLabel')} readOnly={!canEdit} aria-label={t('dimensions.valueLabel')}
              onBlur={(e) => { const label = e.target.value.trim(); if (label !== (v.label ?? '')) void setValueField(i, { label: label || undefined }, t('dimensions.valueNamed', { value: v.value })); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            <span className="m">{t('common.entryCount', { n: count(v.value) })}</span>
            <label className="m"><input type="checkbox" checked={v.active} disabled={!canEdit} onChange={(e) => void setValueField(i, { active: e.target.checked }, t(e.target.checked ? 'dimensions.valueOn' : 'dimensions.valueOff', { value: v.value }))} /> {t('dimensions.active')}</label>
          </div>
        ))}
        {unlisted.map((v) => (
          <div key={v.value} className="dimval new" data-value={v.value}>
            <span className="mono">{v.value}</span>
            <span className="m">{t('dimensions.unlisted')}</span>
            <span className="m">{t('common.entryCount', { n: count(v.value) })}</span>
            {canEdit && <button type="button" className="golink" onClick={() => void addValue(v.value)}>{t('dimensions.list')}</button>}
          </div>
        ))}
        {!d.values.length && !unlisted.length && <p className="m">{t('dimensions.noValues')}</p>}
      </div>
      {canEdit && (
        <form className="dimaddval" onSubmit={(e) => { e.preventDefault(); void addValue(value).then((ok) => { if (ok) setValue(''); }); }}>
          <input value={value} placeholder={t('dimensions.newValue')} aria-label={t('dimensions.newValue')} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="btn" disabled={!tagValue(value)}>{t('dimensions.addValue')}</button>
        </form>
      )}
    </section>
  );
}
