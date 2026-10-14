import type { StatementFacts } from '../../types/drop.js';

/**
 * A dropped file as a camt.053 statement, by its XML namespace, with its facts in short (the
 * account's IBAN, the period of its bookings, how many): for the drop dialog, before anything is
 * read into the books. Undefined when it is no camt.053.
 */
export function recognizeCamt(bytes: Buffer): { facts: StatementFacts } | undefined {
  const start = bytes.subarray(0, 4096).toString('latin1');
  if (!/^\s*(<\?xml|<Document)/.test(start) || !/camt\.053/.test(start)) return undefined;
  const xml = bytes.toString('utf8');
  const iban = /<IBAN>([^<]+)<\/IBAN>/.exec(xml)?.[1];
  const dates = [...xml.matchAll(/<(?:BookgDt|ValDt)>\s*<Dt>(\d{4}-\d{2}-\d{2})<\/Dt>/g)].map((m) => m[1]).sort();
  const entries = (xml.match(/<Ntry>/g) ?? []).length;
  return { facts: { ...(iban ? { iban } : {}), ...(dates.length ? { from: dates[0], to: dates.at(-1) } : {}), entries } };
}
