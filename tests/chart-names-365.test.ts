/**
 * The shipped Swiss chart reads whole (#365 review): a name with commas in a YAML flow mapping was
 * cut at its first comma («Telefon, Internet» read as «Telefon» and a stray key «Internet»). Every
 * account has only the keys the loader knows, and the loader refuses any other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChart, ChartError } from '../src/workspace/chart.js';

const KEYS = new Set(['number', 'name', 'type', 'line', 'profiles', 'legalForms', 'names', 'hints']);

test('every account of the shipped chart has only the keys the loader knows', () => {
  for (const a of loadChart().accounts) assert.deepEqual(Object.keys(a).filter((k) => !KEYS.has(k)), [], a.number);
});

test('names with commas read whole', () => {
  const name = (n: string) => loadChart().accounts.find((a) => a.number === n)?.name;
  const whole: Record<string, string> = {
    '1093': 'Guthaben Zahlungsanbieter (Shopify, Stripe)',
    '1520': 'Büromaschinen, Informatik, Kommunikationstechnologie',
    '1700': 'Patente, Know-how, Lizenzen, Rechte, Entwicklungen',
    '4040': 'Vorlageprovision, Verzollungsspesen',
    '5700': 'Sozialversicherungsaufwand AHV, IV, EO, ALV',
    '6100': 'Unterhalt, Reparaturen, Ersatz',
    '6360': 'Abgaben, Gebühren, Bewilligungen',
    '6500': 'Büromaterial, Verwaltungsaufwand',
    '6510': 'Telefon, Internet',
    '6520': 'Beiträge, Spenden',
    '6540': 'Verwaltungsrat, Generalversammlung, Revisionsstelle',
    '8500': 'Ausserordentlicher, einmaliger oder periodenfremder Aufwand',
    '8510': 'Ausserordentlicher, einmaliger oder periodenfremder Ertrag',
  };
  for (const [n, w] of Object.entries(whole)) assert.equal(name(n), w, n);
});

test('the loader refuses an account with a key it does not know', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chart-'));
  const path = join(dir, 'accounts.yaml');
  writeFileSync(path, 'schema: 1\nname: t\nlines:\n  x: { statement: erfolgsrechnung, label: X }\naccounts:\n  - { number: "6510", name: Telefon, Internet, type: expense, line: x }\n');
  assert.throws(() => loadChart(path), (e: unknown) => e instanceof ChartError && /Internet/.test(String(e)));
});
