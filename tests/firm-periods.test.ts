/**
 * Words and cards that follow the kind of firm (persona round 6, r6f-14, r6f-25, r6f-29): Firma ›
 * Perioden und Siegel lists the firm's own filing periods, or the year for a firm without returns;
 * the year close's last period is «das ganze Jahr» for such a firm and its step 1 is settled; a
 * tax provision is offered to a GmbH, not to an Einzelfirma. The words themselves (lastPeriodOf,
 * periodWord, boxLabel) live beside the dictionary and are checked in the app (verify evidence).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import type { VatSetup } from '../src/workspace/vat-setup.js';
import { periodCards } from '../src/app/areas/company/periods.js';
import { yearEndTemplates } from '../src/accounting/year-close.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const EFFECTIVE: VatSetup = { registered: true, method: 'effective', reporting: 'received', period: 'quarterly' };
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] };
const NONE: VatSetup = { registered: false };
const as = (setup: VatSetup) => setJurisdiction(ch, setup);
const TODAY = '2026-10-16';

test('the period cards: quarters with their due dates on the effective method, half years on the net tax rate, the year alone without returns', () => {
  as(EFFECTIVE);
  assert.deepEqual(periodCards('2026', TODAY, new Set(['2026-Q1', '2026-Q2'])).map((c) => [c.key, c.label, c.state, c.due]), [
    ['2026-Q1', { kind: 'quarter', n: 1 }, 'filed', undefined],
    ['2026-Q2', { kind: 'quarter', n: 2 }, 'filed', undefined],
    ['2026-Q3', { kind: 'quarter', n: 3 }, 'due', '2026-11-29'],
    ['2026-Q4', { kind: 'quarter', n: 4 }, 'runs', undefined],
  ]);
  as(NET_RATE);
  assert.deepEqual(periodCards('2026', TODAY, new Set(['2026-H1'])).map((c) => [c.key, c.label, c.state]), [
    ['2026-H1', { kind: 'half', n: 1 }, 'filed'],
    ['2026-H2', { kind: 'half', n: 2 }, 'runs'],
  ]);
  as(NONE);
  assert.deepEqual(periodCards('2026', TODAY, new Set()).map((c) => [c.key, c.label, c.state]), [['2026-Q4', { kind: 'year' }, 'runs']], 'one card for the year, keyed by the seal the year close writes');
  assert.equal(periodCards('2025', TODAY, new Set())[0].state, 'closesWithYear');
});

test('the tax provision is a GmbH\'s year-end entry, not an Einzelfirma\'s (r6f-14)', () => {
  as(NONE);
  assert.ok(yearEndTemplates('2850', 'GmbH').some((t) => t.id === 'taxProvision'));
  assert.ok(!yearEndTemplates('2850', 'Einzelfirma').some((t) => t.id === 'taxProvision'));
  assert.ok(yearEndTemplates('2850', 'Einzelfirma').some((t) => t.id === 'privateUse'), 'the other entries stay');
  assert.ok(yearEndTemplates().some((t) => t.id === 'taxProvision'), 'without a legal form, every entry');
});
