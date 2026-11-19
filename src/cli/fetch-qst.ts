/**
 * npm run fetch-qst -- <canton> <year> [--file <path>] [--correct | --keep]
 *
 * Fetches a canton's tariff file of the tax at source for a year (docs/specs/payroll.md §3f, phase B2) from
 * where the jurisdiction's payroll.yaml says, checks it (header, trailer count, canton, year) and keeps it
 * under the workspace's data/qst/<year>/ with its checksum, never in git. `--file` takes a file downloaded
 * by hand (the text file or its zip) instead.
 *
 *   npm run fetch-qst -- ZH 2026
 *   npm run fetch-qst -- AG 2026 --correct    a corrected file: carry each closed payslip's difference
 *
 * A file that changes a closed payslip's tax (the first file after payslips closed without it, or a
 * corrected one) is only kept until the person says how: `--correct` carries each difference as a
 * Rückwirkende Korrektur to the person's next open month, `--keep` leaves the closed payslips as they are.
 * Without either it lists them and changes nothing. A closed period offers only `--correct`.
 */
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { loadBooks, periodLock } from '../books/store.js';
import { PayrollRefusal } from '../payroll/close.js';
import { loadTariff } from '../payroll/tariff-load.js';
import { TariffError } from '../payroll/tariffs.js';
import { openWorkspace } from '../workspace/workspace.js';

const args = process.argv.slice(2);
const plain = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--file');
const [region, year] = [plain[0]?.toUpperCase(), plain[1]];
if (!region || !/^[A-Z]{2}$/.test(region) || !year || !/^\d{4}$/.test(year)) {
  console.error('Usage: npm run fetch-qst -- <canton> <year> [--file <path>] [--correct | --keep]   e.g. npm run fetch-qst -- ZH 2026');
  process.exit(2);
}
const at = args.indexOf('--file');
const raw = at >= 0 ? new Uint8Array(readFileSync(args[at + 1])) : undefined;
const bytes = raw && raw[0] === 0x50 && raw[1] === 0x4b ? Object.values(unzipSync(raw)).find((x) => x.length) : raw;
const backdated = args.includes('--correct') ? 'correct' as const : args.includes('--keep') ? 'keep' as const : undefined;

const ws = openWorkspace();
const lock = periodLock(loadBooks(ws));
try {
  const r = await loadTariff(ws, region, year, { ...(bytes ? { bytes } : {}), ...(backdated ? { backdated } : {}), isClosed: (d) => lock.isClosed(d) });
  const what = `${region} ${year} (Stand ${r.version.created}, ${r.version.records} Records, sha256 ${r.version.sha256.slice(0, 12)})`;
  if (r.saved) {
    console.log(r.unchanged ? `Tarif ${what}: unverändert, schon geladen.` : `Tarif ${what} geladen${r.version.url ? ` von ${r.version.url}` : ''}.`);
    if (r.corrections.length) console.log(`${r.corrections.length} Rückwirkende Korrektur(en) für den nächsten offenen Monat der Person erfasst.`);
  } else {
    console.log(`Tarif ${what} ist gespeichert, aber noch nicht gültig: er rechnet abgeschlossene Lohnabrechnungen anders.`);
    for (const a of r.affected) {
      console.log(`  ${a.month} ${a.name}${a.closedPeriod ? ' (geschlossene Periode)' : ''}: ${a.differences.map((d) => `${d.label} ${d.before.toFixed(2)} → ${d.after.toFixed(2)}`).join(', ')}`);
    }
    console.log('Nochmals mit --correct (Rückwirkende Korrektur im nächsten offenen Monat) oder --keep (so lassen).');
    process.exitCode = 3;
  }
} catch (e) {
  if (e instanceof TariffError || e instanceof PayrollRefusal) { console.error(e.message); process.exit(1); }
  throw e;
}
