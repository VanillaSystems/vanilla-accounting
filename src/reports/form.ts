/**
 * The form of Eigene Berichte (src/app/areas/reports/custom/Form.tsx) as data: the spec's fields as
 * a person types them, lists as text with commas, and back to the spec the server checks. A
 * source takes only its own filters, groupings and columns (SOURCE_TAKES): changing the source
 * keeps what the new one takes and drops the rest.
 */
import { SOURCE_TAKES, accountRangeText, isTagGrouping, type Column, type Grouping, type Origin, type ReportSpec, type Source } from './spec.js';

export interface SectionDraft {
  title: string;
  source: Source;
  accounts: string;
  vatCodes: string;
  text: string;
  origins: Origin[];
  receipt: '' | 'with' | 'without';
  currencies: string;
  /** Per reporting dimension the values a booking may carry, as typed with commas (#127). */
  tags: Record<string, string>;
  group: Grouping;
  columns: Column[];
}

export interface FormDraft { title: string; period: string; sections: SectionDraft[]; comment: string }

export const newSection = (source: Source = 'entries'): SectionDraft =>
  ({ title: '', source, accounts: '', vatCodes: '', text: '', origins: [], receipt: '', currencies: '', tags: {}, group: 'none', columns: [...SOURCE_TAKES[source].default] });

export const newDraft = (period: string): FormDraft => ({ title: '', period, sections: [newSection()], comment: '' });

export function draftOf(spec: ReportSpec): FormDraft {
  return {
    title: spec.title,
    period: spec.period,
    comment: spec.comment ?? '',
    sections: spec.sections.map((s) => ({
      title: s.title ?? '',
      source: s.source,
      accounts: (s.filter.accounts ?? []).map(accountRangeText).join(', '),
      vatCodes: (s.filter.vatCodes ?? []).join(', '),
      text: s.filter.text ?? '',
      origins: s.filter.origins ?? [],
      receipt: s.filter.receipt ?? '',
      currencies: (s.filter.currencies ?? []).join(', '),
      tags: Object.fromEntries(Object.entries(s.filter.tags ?? {}).map(([d, vs]) => [d, vs.join(', ')])),
      group: s.group,
      columns: s.columns,
    })),
  };
}

/** The section with another source: the filters, grouping and columns it does not take are gone, the columns its default when none is left. */
export function withSource(s: SectionDraft, source: Source): SectionDraft {
  const takes = SOURCE_TAKES[source];
  const has = (k: string) => (takes.filters as readonly string[]).includes(k);
  const columns = s.columns.filter((c) => takes.columns.includes(c));
  return {
    ...s, source,
    accounts: has('accounts') ? s.accounts : '',
    vatCodes: has('vatCodes') ? s.vatCodes : '',
    origins: has('origins') ? s.origins : [],
    receipt: has('receipt') ? s.receipt : '',
    tags: has('tags') ? s.tags : {},
    group: (isTagGrouping(s.group) ? takes.tags : takes.groups.includes(s.group)) ? s.group : 'none',
    columns: columns.length ? columns : [...takes.default],
  };
}

/** A list as typed: commas or semicolons between items (a range «6000 - 6999» keeps its spaces), spaces too where an item has none. */
const items = (s: string, spaced = true) => s.split(spaced ? /[,;\s]+/ : /[,;]+/).map((x) => x.trim()).filter(Boolean);

/** What the form sends: the spec's raw shape, which parseSpec and the chart check at the server. */
export function rawOf(d: FormDraft): Record<string, unknown> {
  return {
    title: d.title,
    period: d.period,
    sections: d.sections.map((s) => {
      const filter = {
        ...(items(s.accounts, false).length ? { accounts: items(s.accounts, false) } : {}),
        ...(items(s.vatCodes).length ? { vatCodes: items(s.vatCodes) } : {}),
        ...(s.text.trim() ? { text: s.text.trim() } : {}),
        ...(s.origins.length ? { origins: s.origins } : {}),
        ...(s.receipt ? { receipt: s.receipt } : {}),
        ...(items(s.currencies).length ? { currencies: items(s.currencies) } : {}),
        ...((tags) => (Object.keys(tags).length ? { tags } : {}))(Object.fromEntries(Object.entries(s.tags).map(([d, v]) => [d, items(v, false)]).filter(([, vs]) => vs.length))),
      };
      return { ...(s.title.trim() ? { title: s.title.trim() } : {}), source: s.source, filter, group: s.group, columns: s.columns };
    }),
    ...(d.comment.trim() ? { comment: d.comment } : {}),
  };
}
