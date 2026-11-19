/**
 * Where a payslip line's rate comes from, in a few words (docs/specs/payroll.md §5.5: every line names
 * its source): the law's figure of the year with the head of its source (the articles, without the
 * explanation after them, in the reader's language where the year file says them), the firm's insurer
 * by name and the solution the payslip read, or the person's pension certificate. Shown under the line on the payslip's page and in its PDF; the annual
 * wage statement prints none. Pure, browser-safe.
 */
import type { FederalFigure, Labels, PayrollData, PayrollYearData } from '../core/modules/schema.js';
import type { PayrollInsurance, PayslipLine, UsedEntry } from './model.js';

export type LineSource =
  | { kind: 'federal'; year: string; cite: Labels }
  | { kind: 'solution'; insurer: string; code?: string }
  | { kind: 'certificate'; insurer: string }
  | {
    kind: 'tariff'; region: string; year: string; created: string; code: string; income: number; fileOnly?: boolean;
    /** What the code's rate depends on (data `taxAtSource.codeNotes`), said beside the tax line. */
    note?: Labels;
    /** A wage not paid monthly: what was paid on the units worked, how many, the units of a month, and the units' name. */
    units?: { paid: number; quantity: number; per: number; label: Labels };
  };

/** The head of a figure's source: its articles, before the first explanation or the publication in brackets. */
export const citeOf = (source: string): string => source.split(/[:(]/)[0].trim();

/**
 * A figure's articles in each language: the year file's `cite` per language where it has one («LAVS art. 5, 13»
 * in French), else the head of its `source` (a plain string, as before) for every language.
 */
export function citesOf(row: Pick<FederalFigure, 'source' | 'cite'>): Labels {
  const de = row.cite?.de ?? citeOf(row.source);
  return { de, fr: row.cite?.fr ?? de, it: row.cite?.it ?? de, en: row.cite?.en ?? de };
}

/**
 * The source of `line` on the payslip of `slip`: undefined for a line a person entered, the Anstellung's
 * wage, a correction or the 13th (their own words say where they come from).
 */
export function lineSource(
  line: Pick<PayslipLine, 'wageType' | 'source' | 'tariff'>, slip: { month: string; used: readonly UsedEntry[] },
  data: Pick<PayrollData, 'contributions'> & Partial<Pick<PayrollData, 'taxAtSource'>>, years: Readonly<Record<string, PayrollYearData>> | undefined,
  insurances: ReadonlyArray<Pick<PayrollInsurance, 'id' | 'name'>>,
): LineSource | undefined {
  const at = line.source.indexOf(':');
  if (at < 0) return undefined;
  const kind = line.source.slice(0, at);
  const key = line.source.slice(at + 1);
  // The tax at source: the region's file, its date, the code and the rate-determining income it was looked up with.
  if (kind === 'tariff' && line.tariff?.created) {
    const t = line.tariff;
    // The commission names only the file its rate comes from; the tax names the code and the income it was looked up with.
    const tax = data.contributions.some((c) => c.wageType === line.wageType);
    const note = tax ? codeNoteOf(data, t.code) : undefined;
    const unit = t.units ? data.taxAtSource?.notMonthly?.units.find((u) => u.key === t.units!.key) : undefined;
    const units = t.units && unit ? { paid: t.units.paid, quantity: t.units.quantity, per: t.units.per, label: unit.label } : undefined;
    return { kind: 'tariff', region: t.region, year: key.split(':')[1] ?? slip.month.slice(0, 4), created: t.created!, code: t.code, income: t.income, ...(tax ? {} : { fileOnly: true }), ...(note ? { note } : {}), ...(units ? { units } : {}) };
  }
  if (kind === 'federal') {
    // The row the payslip read (a figure may change inside the year; a payment after the exit reads its earned year's), else the latest.
    const used = slip.used.find((u) => u.path === `federal/${key}`)?.validFrom;
    const year = used?.slice(0, 4) ?? slip.month.slice(0, 4);
    const rows = years?.[year]?.figures[key];
    const list = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
    const row = list.find((r) => r.validFrom === used) ?? list.at(-1);
    return row ? { kind: 'federal', year, cite: citesOf(row) } : undefined;
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
const day = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const amount = (x: number) => new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
const units = (x: number) => new Intl.NumberFormat('de-CH', { maximumFractionDigits: 3 }).format(x);

export function sourceText(s: LineSource, documents: Pick<PayrollData['documents'], 'sourceFederal' | 'sourceSolution' | 'sourceCertificate'> & Partial<Pick<PayrollData['documents'], 'sourceTariff' | 'sourceTariffUnits'>>, lang: keyof Labels): string {
  const w = (l: Labels) => l[lang] ?? l.de;
  switch (s.kind) {
    case 'federal': return `${w(documents.sourceFederal).replace('{year}', s.year)} · ${w(s.cite)}`;
    case 'solution': return s.code ? `${s.insurer}, ${w(documents.sourceSolution).replace('{code}', s.code)}` : s.insurer;
    case 'certificate': return `${w(documents.sourceCertificate)} ${s.insurer}`;
    case 'tariff': return (documents.sourceTariff
      ? (s.fileOnly ? w(documents.sourceTariff).split(' · ')[0] : w(documents.sourceTariff)).replace('{region}', s.region).replace('{year}', s.year).replace('{date}', day(s.created)).replace('{code}', s.code).replace('{income}', amount(s.income))
      : `${s.region} ${s.year} ${s.code}`)
      + (s.units && documents.sourceTariffUnits ? ` · ${w(documents.sourceTariffUnits).replace('{paid}', amount(s.units.paid)).replace('{quantity}', units(s.units.quantity)).replace('{per}', units(s.units.per)).replace(/\{unit\}/g, w(s.units.label))}` : '')
      + (s.note ? ` · ${w(s.note)}` : '');
  }
}

/** What a tariff code's rate depends on, where the data says (`taxAtSource.codeNotes`): the first note whose pattern matches. */
export function codeNoteOf(data: Partial<Pick<PayrollData, 'taxAtSource'>>, code: string | undefined): Labels | undefined {
  if (!code) return undefined;
  return data.taxAtSource?.codeNotes?.find((n) => new RegExp(n.codes).test(code.toUpperCase()))?.text;
}
