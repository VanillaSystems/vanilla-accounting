/**
 * Where a payslip line's rate comes from, in a few words (docs/specs/payroll.md §5.5: every line names
 * its source): the law's figure of the year with the head of its source (the articles, without the
 * explanation after them), the firm's insurer by name and the solution the payslip read, or the
 * person's pension certificate. Shown under the line on the payslip's page and in its PDF; the annual
 * wage statement prints none. Pure, browser-safe.
 */
import type { Labels, PayrollData, PayrollYearData } from '../core/modules/schema.js';
import type { PayrollInsurance, PayslipLine, UsedEntry } from './model.js';

export type LineSource =
  | { kind: 'federal'; year: string; cite: string }
  | { kind: 'solution'; insurer: string; code?: string }
  | { kind: 'certificate'; insurer: string };

/** The head of a figure's source: its articles, before the first explanation or the publication in brackets. */
export const citeOf = (source: string): string => source.split(/[:(]/)[0].trim();

/**
 * The source of `line` on the payslip of `slip`: undefined for a line a person entered, the Anstellung's
 * wage, a correction or the 13th (their own words say where they come from).
 */
export function lineSource(
  line: Pick<PayslipLine, 'wageType' | 'source'>, slip: { month: string; used: readonly UsedEntry[] },
  data: Pick<PayrollData, 'contributions'>, years: Readonly<Record<string, PayrollYearData>> | undefined,
  insurances: ReadonlyArray<Pick<PayrollInsurance, 'id' | 'name'>>,
): LineSource | undefined {
  const at = line.source.indexOf(':');
  if (at < 0) return undefined;
  const kind = line.source.slice(0, at);
  const key = line.source.slice(at + 1);
  if (kind === 'federal') {
    const year = slip.month.slice(0, 4);
    const rows = years?.[year]?.figures[key];
    const list = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
    // The row the payslip read (a figure may change inside the year), else the latest.
    const used = slip.used.find((u) => u.path === `federal/${key}`)?.validFrom;
    const row = list.find((r) => r.validFrom === used) ?? list.at(-1);
    return row ? { kind: 'federal', year, cite: citeOf(row.source) } : undefined;
  }
  if (kind === 'insurance') {
    const ins = insurances.find((i) => i.id === key);
    if (!ins) return undefined;
    const c = data.contributions.find((x) => x.wageType === line.wageType);
    if (c && 'person' in c.rate) return { kind: 'certificate', insurer: ins.name };
    const prefix = `insurances/${key}/solutions/`;
    const code = slip.used.find((u) => u.path.startsWith(prefix))?.path.slice(prefix.length).split('/')[0];
    return { kind: 'solution', insurer: ins.name, ...(code ? { code } : {}) };
  }
  return undefined;
}

/** The source in words of `lang`, from the jurisdiction's document words. */
export function sourceText(s: LineSource, documents: Pick<PayrollData['documents'], 'sourceFederal' | 'sourceSolution' | 'sourceCertificate'>, lang: keyof Labels): string {
  const w = (l: Labels) => l[lang] ?? l.de;
  switch (s.kind) {
    case 'federal': return `${w(documents.sourceFederal).replace('{year}', s.year)} · ${s.cite}`;
    case 'solution': return s.code ? `${s.insurer}, ${w(documents.sourceSolution).replace('{code}', s.code)}` : s.insurer;
    case 'certificate': return `${w(documents.sourceCertificate)} ${s.insurer}`;
  }
}
