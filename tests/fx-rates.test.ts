/**
 * Characterization of the booking FX resolver: the ESTV daily sell rate on the payment date
 * (ADR 0001), the most-recent-rate fallback, and the legacy flat rate as last resort.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import './support/jurisdiction.js';

test('real ESTV rate file: each payment date gets its own daily sell rate', () => {
  const fx = loadFxResolver();
  assert.equal(fx.daily('EUR', '2026-01-05'), 0.93966);
  assert.equal(fx.daily('USD', '2026-01-05'), 0.80043);
  assert.equal(fx.daily('EUR', '2026-04-07'), 0.92952);
  assert.equal(fx.daily('USD', '2026-04-07'), 0.80487);
  assert.equal(fx.daily('CHF', '2026-04-07'), 1);
  assert.equal(fx.daily('EUR', '2025-01-01'), undefined, 'before the first recorded rate');
  assert.equal(fx.daily('GBP', '2026-04-07'), undefined, 'a currency ESTV rates are not fetched for');
  assert.equal(fx.flat('EUR'), 0.91);
  assert.equal(fx.flat('USD'), 0.78);
  assert.equal(fx.flat('CHF'), 1);
});

test('synthetic rate file: weekend and gap fall back to the most recent earlier rate', () => {
  const root = mkdtempSync(join(tmpdir(), 'fx-'));
  try {
    writeFileSync(join(root, 'estv-daily-rates-2026.json'), JSON.stringify({
      rates: {
        '2026-07-03': { EUR: 0.931, USD: 0.801, src: 'datum 2026-07-03' },
        '2026-07-06': { EUR: 0.935, src: 'datum 2026-07-06' },
        '2026-07-02': { EUR: 0.929, USD: 0.799, src: 'datum 2026-07-02' },
      },
    }));
    const fx = loadFxResolver(root);
    assert.equal(fx.daily('EUR', '2026-07-02'), 0.929);
    assert.equal(fx.daily('EUR', '2026-07-04'), 0.931, 'Saturday uses Friday');
    assert.equal(fx.daily('EUR', '2026-07-06'), 0.935);
    assert.equal(fx.daily('USD', '2026-07-06'), 0.801, 'missing currency on the day uses its last recorded rate');
    assert.equal(fx.daily('EUR', '2026-12-31'), 0.935, 'after the last recorded date');
    assert.equal(fx.daily('EUR', '2026-07-01'), undefined, 'never a rate from after the payment date');
    assert.equal(fx.flat('EUR'), undefined, 'no wechselkurse.txt, no flat rate');
    assert.equal(fx.flat('CHF'), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no rate files at all: only CHF resolves', () => {
  const root = mkdtempSync(join(tmpdir(), 'fx-'));
  try {
    const fx = loadFxResolver(root);
    assert.equal(fx.daily('EUR', '2026-07-02'), undefined);
    assert.equal(fx.daily('CHF', '2026-07-02'), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
