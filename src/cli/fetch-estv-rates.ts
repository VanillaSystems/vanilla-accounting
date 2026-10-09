/**
 * Fetch official ESTV/BAZG daily foreign-exchange SELL rates (Devisenkurs Verkauf)
 * and cache them keyed by the calendar date each rate is valid for.
 *
 * Swiss VAT (MWSTG Art. 24; MWST-Info 03) lets you convert foreign amounts with either
 * the ESTV monthly average rate OR the daily sell rate — one method, consistently, per tax
 * period. This project uses the DAILY sell rate: on cash basis the rate date is the payment
 * date (the day the money moved), so each booking gets the rate valid on that exact day.
 *
 * Source: https://www.backend-rates.bazg.admin.ch/api/xmldaily?d=YYYYMMDD
 * The single published <kurs> is the sell rate ESTV mandates (estv.admin.ch/de/mwst-tageskurse
 * → "Tageskurs BAZG: Devisenkurse (Verkauf)"). Each publication carries a <gueltigkeit> list of
 * the calendar dates it applies to, so Friday's rate rolls over the weekend — matching the ESTV
 * rule "should the current rate not yet be published, apply the most recently recorded one".
 *
 * Output: reference/estv-daily-rates-2026.json  (checked in, auditor-verifiable)
 *
 * Usage: npm run fetch-rates            # skips if the file already covers the range
 *        npm run fetch-rates -- --force # refetch everything from START
 *        npm run fetch-rates -- --end 2026-09-30
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';
import { REFERENCE_DIR } from '../workspace/workspace.js';

const RATES_PATH = join(REFERENCE_DIR, 'estv-daily-rates-2026.json');

// Currencies we actually book in (see BankTransaction currencies). GBP is only used for
// receipt↔transaction proximity ranking in match.ts, never for booking, so it is out of scope.
const CURRENCIES = ['EUR', 'USD'];

// Fetch publication dates from late Dec 2025 (so the New-Year holiday inherits Dec's last rate)
// up to the end date. END used to be hardcoded to the end of H1 2026, which made this script a
// SILENT NO-OP for every later quarter: it printed "already covers through 2026-06-30 ✓" and
// exited, so `classify` ran a whole quarter with no booking rates. END now defaults to today
// (no rate can exist for the future) and can be overridden: `npm run fetch-rates -- --end 2026-09-30`.
const START = '2025-12-22';
const endArgIdx = process.argv.indexOf('--end');
const endArg = endArgIdx >= 0 ? process.argv[endArgIdx + 1] : undefined;
if (endArg && !/^\d{4}-\d{2}-\d{2}$/.test(endArg)) {
  console.error(`Invalid --end date: ${endArg}. Use YYYY-MM-DD.`);
  process.exit(1);
}
const END = endArg ?? new Date().toISOString().slice(0, 10);

const API = 'https://www.backend-rates.bazg.admin.ch/api/xmldaily';

interface RateFile {
  source: string;
  note: string;
  fetchedAt: string;
  /** validity date (YYYY-MM-DD) -> { EUR, USD, src } — currency values are CHF per 1 unit;
   *  `src` records which publication (datum) the rate came from, for auditing. */
  rates: Record<string, Record<string, number | string>>;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** "16.01.2026" -> "2026-01-16" */
function isoFromSwiss(d: string): string {
  const [dd, mm, yyyy] = d.trim().split('.');
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/** "2026-01-16" -> "20260116" */
function compact(iso: string): string {
  return iso.replace(/-/g, '');
}

function eachWeekday(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0 Sun .. 6 Sat
    if (dow !== 0 && dow !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPublication(datumIso: string): Promise<
  { gueltigkeit: string[]; kurs: Record<string, number> } | null
> {
  const res = await fetch(`${API}?d=${compact(datumIso)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = parser.parse(await res.text())?.wechselkurse;
  if (!doc) return null;

  // Guard: querying a non-publication day (holiday) can echo back a different datum — key
  // strictly on the returned gueltigkeit, so a stale echo just re-writes the same dates.
  const gueltigkeit = String(doc.gueltigkeit ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(isoFromSwiss);
  if (!gueltigkeit.length) return null;

  const list = Array.isArray(doc.devise) ? doc.devise : [doc.devise];
  const kurs: Record<string, number> = {};
  for (const dev of list) {
    const code = String(dev?.['@_code'] ?? '').toUpperCase();
    if (!CURRENCIES.includes(code)) continue;
    // waehrung is like "1 EUR" or "100 SEK" — divide by the multiplier to get CHF per 1 unit.
    const mult = parseInt(String(dev.waehrung ?? '1'), 10) || 1;
    const rate = parseFloat(String(dev.kurs));
    if (Number.isFinite(rate)) kurs[code] = rate / mult;
  }
  return { gueltigkeit, kurs };
}

async function main() {
  const force = process.argv.includes('--force');
  // Keep whatever is already cached and only fetch forward from it — a new quarter must never
  // require refetching (and re-rate-limiting) six months of history.
  let rates: RateFile['rates'] = {};
  let fetchFrom = START;
  if (existsSync(RATES_PATH) && !force) {
    const existing: RateFile = JSON.parse(readFileSync(RATES_PATH, 'utf8'));
    rates = { ...existing.rates };
    const have = Object.keys(rates).sort();
    const last = have[have.length - 1];
    if (last && last >= END) {
      console.log(`✓ ${RATES_PATH} already covers ${END} (last rate ${last}). Use --force to refetch.`);
      return;
    }
    if (last) {
      // re-fetch the last cached day too, so a weekend roll-over gets completed
      fetchFrom = last;
      console.log(`Extending existing cache (${have[0]} .. ${last}) forward to ${END}…`);
    }
  }

  const weekdays = eachWeekday(fetchFrom, END);
  console.log(`Fetching ESTV daily sell rates for ${weekdays.length} publication days (${fetchFrom}..${END})…`);

  let ok = 0;
  const failures: string[] = [];
  for (const datum of weekdays) {
    try {
      const pub = await fetchPublication(datum);
      if (!pub) { failures.push(datum); continue; }
      for (const validOn of pub.gueltigkeit) {
        rates[validOn] = { ...pub.kurs, src: `datum ${datum}` };
      }
      ok++;
    } catch (err) {
      failures.push(`${datum} (${(err as Error).message})`);
    }
    await sleep(120); // be polite to the public API
  }

  const covered = Object.keys(rates).sort();
  const missingCur = covered
    .filter((d) => d >= fetchFrom)
    .filter((d) => CURRENCIES.some((c) => rates[d][c] === undefined));

  const out: RateFile = {
    source: `${API}?d=YYYYMMDD — ESTV/BAZG Devisenkurs (Verkauf), the sell rate ESTV mandates for MWST`,
    note: 'Daily sell rates for Swiss VAT foreign-currency conversion (MWSTG Art. 24). Keyed by the calendar date the rate is valid for (gueltigkeit). Values are CHF per 1 unit of the currency.',
    fetchedAt: new Date().toISOString(),
    rates,
  };
  writeFileSync(RATES_PATH, JSON.stringify(out, null, 2) + '\n');

  console.log(`\n✓ Wrote ${RATES_PATH}`);
  console.log(`  publications fetched : ${ok}/${weekdays.length}`);
  console.log(`  validity dates mapped: ${covered.length} (${covered[0]} .. ${covered[covered.length - 1]})`);
  if (missingCur.length) console.log(`  ⚠ dates missing a currency: ${missingCur.join(', ')}`);
  if (failures.length) console.log(`  ⚠ no publication for: ${failures.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
