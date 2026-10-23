/**
 * Reporting dimensions (#127): a project, a cost centre, a location. The workspace declares its
 * dimensions in belege.workspace.yaml (`dimensions`); a booking carries at most one value per
 * dimension in `JournalEntry.tags`. Tags sort bookings for the reports; no figure of a VAT return
 * reads them. Browser-safe and pure: the manifest's reader, the API, the rules and the UI share it.
 */

/** One value a dimension knows: what bookings carry (`value`), how it reads (`label`), offered for new bookings while `active`. */
export interface DimensionValue { value: string; label?: string; active: boolean }

/** A dimension the workspace declares: its id (the key in `tags`), its name, the values it offers. */
export interface Dimension { id: string; label: string; values: DimensionValue[] }

/** A booking's tags: per dimension id its one value. */
export type Tags = Record<string, string>;

export const DIMENSION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_VALUE = 64;

/** A value as bookings carry it: trimmed, on one line, at most 64 characters; undefined when it is none. */
export function tagValue(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
  return s && s.length <= MAX_VALUE && !/[\u0000-\u001f]/.test(s) ? s : undefined;
}

export type TagRefusal =
  | { code: 'tagShape' }
  | { code: 'tagDimension'; params: { dimension: string } }
  | { code: 'tagValue'; params: { dimension: string; value: string } };

/**
 * Tags as a writer sends them, checked against the declared dimensions: a map from dimension id to
 * one value; an empty value drops that dimension. Undefined tags: none (an empty map is none too).
 */
export function parseTags(raw: unknown, dimensions: readonly Pick<Dimension, 'id'>[]): { ok: true; tags: Tags | undefined } | { ok: false; refusal: TagRefusal } {
  if (raw === undefined || raw === null) return { ok: true, tags: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, refusal: { code: 'tagShape' } };
  const out: Tags = {};
  for (const [dimension, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!dimensions.some((d) => d.id === dimension)) return { ok: false, refusal: { code: 'tagDimension', params: { dimension } } };
    if (v === '' || v === null || v === undefined) continue;
    const value = tagValue(v);
    if (!value) return { ok: false, refusal: { code: 'tagValue', params: { dimension, value: String(v) } } };
    out[dimension] = value;
  }
  return { ok: true, tags: Object.keys(out).length ? sortedTags(out) : undefined };
}

/** The tags in dimension order of their keys, so two equal maps write the same JSON. */
export const sortedTags = (tags: Tags): Tags => Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)));

export const sameTags = (a: Tags | undefined, b: Tags | undefined): boolean => JSON.stringify(sortedTags(a ?? {})) === JSON.stringify(sortedTags(b ?? {}));

/**
 * The values a field offers for `dimension`: the declared ones that are active, then the values
 * bookings carry that the declaration does not list (a «new value» typed by hand), in order.
 */
export function offeredValues(dimension: Dimension, entries: readonly { tags?: Tags }[]): DimensionValue[] {
  const declared = dimension.values.filter((v) => v.active);
  const listed = new Set(dimension.values.map((v) => v.value));
  const used = [...new Set(entries.map((e) => e.tags?.[dimension.id]).filter((v): v is string => !!v && !listed.has(v)))].sort((a, b) => a.localeCompare(b));
  return [...declared, ...used.map((value) => ({ value, active: true }))];
}

/** How a value reads: its declared label, else the value itself. */
export function valueLabel(dimension: Pick<Dimension, 'values'> | undefined, value: string): string {
  return dimension?.values.find((v) => v.value === value)?.label ?? value;
}

/** A filter over tags: per dimension the values a booking may carry (any of them); every dimension named must hold. */
export type TagFilter = Record<string, string[]>;

export function matchesTags(tags: Tags | undefined, filter: TagFilter | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([dimension, values]) => !values.length || values.includes(tags?.[dimension] ?? ''));
}

/** How many bookings carry a value of `dimension`: a dimension in use is not removed. */
export const usesOf = (dimension: string, entries: readonly { tags?: Tags }[]): number => entries.filter((e) => e.tags?.[dimension] !== undefined).length;

/**
 * The `dimensions` block of belege.workspace.yaml (src/workspace/manifest.ts): a list of
 * `{ id, label, values }`, where a value is a text or `{ value, label?, active? }`. `fail` throws.
 */
export function readDimensions(raw: unknown, fail: (msg: string) => never): Dimension[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return fail('dimensions must be a list of { id, label, values }');
  const seen = new Set<string>();
  return raw.map((d, i): Dimension => {
    const where = `dimensions[${i}]`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return fail(`${where} must be { id, label, values }`);
    const m = d as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!DIMENSION_ID.test(id)) fail(`${where}.id "${String(m.id ?? '')}" must be lower-case letters, digits and -, starting with a letter (projekt, kostenstelle)`);
    if (seen.has(id)) fail(`dimensions: ${id} is listed twice`);
    seen.add(id);
    const label = typeof m.label === 'string' && m.label.trim() ? m.label.trim() : fail(`${where}.label must be a non-empty text`);
    if (m.values !== undefined && m.values !== null && !Array.isArray(m.values)) fail(`${where}.values must be a list`);
    const values = new Set<string>();
    return {
      id, label,
      values: ((m.values as unknown[] | undefined) ?? []).map((v, j): DimensionValue => {
        const at = `${where}.values[${j}]`;
        const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : { value: v };
        const value = tagValue(o.value) ?? fail(`${at}: a value is a text of at most ${MAX_VALUE} characters on one line`);
        if (values.has(value)) fail(`${where}: the value ${value} is listed twice`);
        values.add(value);
        if (o.label !== undefined && (typeof o.label !== 'string' || !o.label.trim())) fail(`${at}.label must be a non-empty text`);
        if (o.active !== undefined && typeof o.active !== 'boolean') fail(`${at}.active must be true or false`);
        return { value, ...(typeof o.label === 'string' ? { label: o.label.trim() } : {}), active: o.active !== false };
      }),
    };
  });
}

/** A dimension as the manifest writes it: a value without label that is active is a plain text. */
export function dimensionYaml(d: Dimension): Record<string, unknown> {
  return {
    id: d.id, label: d.label,
    values: d.values.map((v) => (v.label === undefined && v.active ? v.value : { value: v.value, ...(v.label !== undefined ? { label: v.label } : {}), ...(v.active ? {} : { active: false }) })),
  };
}
