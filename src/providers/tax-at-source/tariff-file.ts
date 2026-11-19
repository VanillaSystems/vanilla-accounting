/**
 * The ESTV's Quellensteuer tariff file for wages, one per canton and year (tarJJkt.txt, «Aufbau und
 * Recordformate der Quellensteuer-Tarife für den Import in Lohnbuchhaltungssysteme», valid from 2025 and
 * unchanged for 2027): fixed-width ASCII records of 62 characters, a header (00), the progressive tariffs
 * (06: one record per tariff code and income bracket), the predefined categories (11), the commission
 * (12, Bezugsprovision) and the median (13), and a trailer (99) that counts every record. Amounts are in
 * Rappen, rates in hundredths of a percent, each bracket is a monthly income from `from` Franken for
 * `step` Franken. Pure: the caller reads the file and keeps its checksum.
 */

/** One income bracket of a tariff code: from `from` Franken (inclusive) for `step` Franken. */
export interface TariffBracket {
  from: number;
  step: number;
  /** The tax rate in percent. */
  rate: number;
  /** A minimum tax in Franken (a canton's poll tax): a smaller tax is raised to it; 0 where the canton has none. */
  minimum: number;
}

/** The brackets of one tariff code that hold from one day, sorted by `from`. */
export interface TariffTable { validFrom: string; brackets: TariffBracket[] }

export interface TariffFile {
  /** The canton's two letters, as the file names it (ZH, BE). */
  canton: string;
  /** The day the canton made the file (header, YYYY-MM-DD): a corrected file has a later one. */
  created: string;
  /** Every record, header and trailer included, as the trailer counts them. */
  records: number;
  /** By tariff code (A0N, B2Y, L0N, G9N, HEN, …): its tables, the latest `validFrom` last. */
  tariffs: Map<string, TariffTable[]>;
  /** The commission in percent of the tax, by its code: PEL (electronic settlement), PPA (paper), PSP (simplified procedure). */
  provisions: Map<string, Array<{ validFrom: string; rate: number }>>;
  /** The canton's highest rate-determining income of a spouse for tariff C (MED), in Franken. */
  median?: number;
}

export class TariffFileError extends Error {}

const day = (s: string): string => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const digits = (s: string, what: string, line: number): number => {
  if (!/^\d+$/.test(s)) throw new TariffFileError(`Zeile ${line}: ${what} «${s}» ist keine Zahl.`);
  return Number(s);
};

/**
 * Reads a tariff file. Refuses a file that is not one (no header or trailer, a trailer that counts other
 * records, a record of another canton, a record that changes or deletes an earlier one: a full file only
 * adds), so a cut or mixed download never computes a tax.
 */
export function parseTariffFile(text: string): TariffFile {
  // A byte-order mark (as an editor may add it) and an end-of-file character are no part of a record.
  const lines = text.replace(/^(\uFEFF|\u00EF\u00BB\u00BF)/, '').replace(/\x1a/g, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length || !lines[0].startsWith('00')) throw new TariffFileError('Kein Vorlaufrecord (00): keine Tarifdatei.');
  const head = lines[0];
  const canton = head.slice(2, 4);
  if (!/^[A-Z]{2}$/.test(canton)) throw new TariffFileError('Der Vorlaufrecord nennt keinen Kanton.');
  const created = day(head.slice(19, 27));
  if (!/^\d{8}$/.test(head.slice(19, 27))) throw new TariffFileError('Der Vorlaufrecord nennt kein Erstellungsdatum.');
  const tail = lines.at(-1)!;
  if (!tail.startsWith('99')) throw new TariffFileError('Kein Endrecord (99): die Datei ist unvollständig.');
  const count = digits(tail.slice(19, 27), 'Anzahl Records', lines.length);
  // The trailer's «Checksumme Betrag» is empty by the format (Ziff. 3.7): the count is the check it defines.
  if (count !== lines.length) throw new TariffFileError(`Der Endrecord zählt ${count} Records, die Datei hat ${lines.length}: sie ist unvollständig.`);
  if (tail.slice(17, 19) !== canton) throw new TariffFileError(`Der Endrecord nennt den Kanton ${tail.slice(17, 19)}, der Vorlauf ${canton}.`);

  const tariffs = new Map<string, Map<string, TariffBracket[]>>();
  const provisions = new Map<string, Array<{ validFrom: string; rate: number }>>();
  let median: number | undefined;
  for (let i = 1; i < lines.length - 1; i++) {
    const r = lines[i];
    const n = i + 1;
    const kind = r.slice(0, 2);
    if (r.slice(2, 4) !== '01') throw new TariffFileError(`Zeile ${n}: Transaktionsart ${r.slice(2, 4)} (Mutation oder Löschung): nur eine vollständige Tarifdatei wird gelesen.`);
    if (r.slice(4, 6) !== canton) throw new TariffFileError(`Zeile ${n}: Kanton ${r.slice(4, 6)} in einer Datei von ${canton}.`);
    const code = r.slice(6, 16).trim();
    const validFrom = day(r.slice(16, 24));
    const from = digits(r.slice(24, 33), 'Einkommen ab', n) / 100;
    const step = digits(r.slice(33, 42), 'Tarifschritt', n) / 100;
    const minimum = digits(r.slice(45, 54), 'Mindeststeuer', n) / 100;
    const rate = digits(r.slice(54, 59), 'Steuersatz', n) / 100;
    if (kind === '06' || kind === '11') {
      const byDay = tariffs.get(code) ?? new Map<string, TariffBracket[]>();
      byDay.set(validFrom, [...(byDay.get(validFrom) ?? []), { from, step, rate, minimum }]);
      tariffs.set(code, byDay);
    } else if (kind === '12') {
      provisions.set(code, [...(provisions.get(code) ?? []), { validFrom, rate }]);
    } else if (kind === '13') {
      median = minimum;
    } else {
      throw new TariffFileError(`Zeile ${n}: Recordart ${kind} kennt das Format nicht.`);
    }
  }
  const out = new Map<string, TariffTable[]>();
  for (const [code, byDay] of tariffs) {
    out.set(code, [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([validFrom, brackets]) => ({ validFrom, brackets: brackets.sort((a, b) => a.from - b.from) })));
  }
  for (const list of provisions.values()) list.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return { canton, created, records: count, tariffs: out, provisions, ...(median !== undefined ? { median } : {}) };
}

/**
 * The bracket of `code` for a monthly rate-determining `income` on `on`: the one whose range holds it
 * (the largest `from` not above it; an income below the first bracket takes the first). Undefined when
 * the file has no such code, or none of its tables holds yet.
 */
export function bracketOf(file: TariffFile, code: string, income: number, on: string): TariffBracket | undefined {
  const table = (file.tariffs.get(code) ?? []).filter((t) => t.validFrom <= on).at(-1);
  if (!table?.brackets.length) return undefined;
  let hit = table.brackets[0];
  for (const b of table.brackets) {
    if (b.from <= income) hit = b;
    else break;
  }
  return hit;
}

/** The commission's rate in percent under `code` on `on`, or undefined. */
export function provisionOf(file: TariffFile, code: string, on: string): number | undefined {
  return (file.provisions.get(code) ?? []).filter((p) => p.validFrom <= on).at(-1)?.rate;
}
