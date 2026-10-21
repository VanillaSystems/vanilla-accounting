/**
 * The app's URLs (src/app/shell/route.ts, docs/urls.md): every path parses to its route and is
 * written back exactly as it was, other spellings redirect to the one canonical path, and every
 * old /<lang>/<period>/<tab>?… link redirects to the place it named.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocation, isRedirect, parseLocation, type Location } from '../src/app/shell/route.js';

const TODAY = '2026-10-09';
const parse = (url: string) => {
  const [path, search = ''] = url.split('?');
  return parseLocation(path, search ? `?${search}` : '', TODAY);
};

const CANONICAL = [
  '/receipts',
  '/receipts/3f2a9c01b7d4e5f6',
  '/receipts?filter=offen&q=coop',
  '/receipts?period=2026-Q3&filter=ohneDatum',
  '/bank',
  '/bank/1021-2026-09',
  '/bank/1021-2026-09/ZKB-4711~2',
  '/payments/ZKB-4711',
  '/journal',
  '/journal/M2026-001',
  '/journal?vat=I81',
  '/vat',
  '/vat/405?period=2026-Q3',
  '/vat/codes',
  '/vat/codes/I81',
  '/vat/codes/-V81',
  '/reports/income',
  '/reports/balance/1021',
  '/reports/trial?period=2026',
  '/close',
  '/close/revaluation',
  '/company/profile',
  '/company/invoice-layout',
  '/company/display',
  '/invoices',
  '/invoices?status=overdue',
  '/invoices/2026-006',
  '/invoices/draft-a1b2',
  '/invoices/customers',
  '/invoices/customers/c-17',
  '/invoices/sent',
  '/invoices/sent/d-42',
  '/invoices/new?customer=cu_17',
  '/company/rules?payment=2026-08-12-a1',
  '/journal?period=2026-07-01_2026-09-30',
  '/journal?period=2026-09',
  '/journal?period=ytd',
  '/journal?period=all',
  '/receipts?q=a+b%26c',
  '/automation',
  '/automation/workflows',
  '/automation/booking',
  '/automation/booking/runs',
  '/automation/booking/graph/classify',
  '/automation/runs',
  '/automation/runs/booking-1a2b3c4d',
  '/automation/map',
  '/automation/map/events',
  '/automation/queue',
  '/automation/tasks',
  '/automation/tasks/booking-1a2b3c4d',
  '/changes',
  '/changes/3f2a9c0',
  '/changes/draft/knowledge%2Frules%2Fbooking.guide.yaml',
  '/changes/3f2a9c0/vanilla-accounting%2Fledger.json',
];

test('every path of urls.md parses and formats back to itself', () => {
  for (const url of CANONICAL) {
    const p = parse(url);
    assert.ok(!isRedirect(p), `${url} redirected to ${isRedirect(p) && formatLocation(p.redirect)}`);
    assert.equal(formatLocation(p), url);
  }
});

test('the routes the paths name', () => {
  const route = (url: string) => (parse(url) as Location).route;
  assert.deepEqual(route('/receipts/3f2a9c01b7d4e5f6'), { area: 'receipts', id: '3f2a9c01b7d4e5f6' });
  assert.deepEqual(route('/bank/1021-2026-09/ZKB-4711~2'), { area: 'bank', statement: '1021-2026-09', payment: 'ZKB-4711~2' });
  assert.deepEqual(route('/payments/ZKB-4711'), { area: 'bank', payment: 'ZKB-4711' });
  assert.deepEqual(route('/vat/405'), { area: 'vat', ziffer: '405' });
  assert.deepEqual(route('/vat/codes/I81'), { area: 'codes', code: 'I81' });
  assert.deepEqual(route('/reports/balance/1021'), { area: 'reports', report: 'balance', account: '1021' });
  assert.deepEqual(route('/company/banks'), { area: 'company', section: 'banks' });
  assert.deepEqual(route('/invoices/2026-006'), { area: 'invoices', view: 'list', id: '2026-006' });
  assert.deepEqual(route('/invoices/sent/d-42'), { area: 'invoices', view: 'sent', id: 'd-42' });
  assert.deepEqual(route('/automation'), { area: 'automation', view: 'home' });
  assert.deepEqual(route('/automation/runs'), { area: 'automation', view: 'runs' });
  assert.deepEqual(route('/automation/workflows'), { area: 'automation', view: 'workflow', tab: 'graph' });
  assert.deepEqual(route('/automation/booking/triggers'), { area: 'automation', view: 'workflow', workflow: 'booking', tab: 'triggers' });
  assert.deepEqual(route('/automation/booking/graph/classify'), { area: 'automation', view: 'workflow', workflow: 'booking', tab: 'graph', step: 'classify' });
  assert.deepEqual(route('/automation/runs/booking-1a2b'), { area: 'automation', view: 'run', run: 'booking-1a2b' });
  assert.deepEqual(route('/automation/map/events'), { area: 'automation', view: 'map', map: 'events' });
  assert.deepEqual(route('/automation/tasks/booking-1a2b'), { area: 'automation', view: 'tasks', run: 'booking-1a2b' });
  assert.deepEqual(route('/changes/3f2a9c0'), { area: 'changes', commit: '3f2a9c0' });
  assert.deepEqual(route('/changes/outside/mail.yaml'), { area: 'changes', commit: 'outside', file: 'mail.yaml' });
});

test('automation: the default tab leaves no segment, an unknown tab is the graph', () => {
  assert.equal(formatLocation((parse('/automation/booking/graph') as { redirect: Location }).redirect), '/automation/booking');
  assert.equal(formatLocation((parse('/automation/booking/nonsense') as { redirect: Location }).redirect), '/automation/booking');
});

test('the period leaves the parser as a Period, a range in either spelling', () => {
  const period = (url: string) => (parse(url) as Location).query.period;
  assert.deepEqual(period('/journal?period=2026-07-01_2026-09-30'), { token: '2026-07-01..2026-09-30', kind: 'range', from: '2026-07-01', to: '2026-09-30' });
  assert.equal(period('/journal?period=2026-Q3')!.to, '2026-09-30');
  assert.equal(period('/journal'), undefined);
  const dotted = parse('/journal?period=2026-07-01..2026-08-15');
  assert.ok(isRedirect(dotted));
  assert.equal(formatLocation(dotted.redirect), '/journal?period=2026-07-01_2026-08-15');
});

test('other spellings redirect to the canonical path', () => {
  const to = (url: string) => {
    const p = parse(url);
    assert.ok(isRedirect(p), `${url} should redirect`);
    return formatLocation(p.redirect);
  };
  assert.equal(to('/'), '/receipts');
  assert.equal(to('/journal/'), '/journal');
  assert.equal(to('/reports'), '/reports/income');
  assert.equal(to('/reports/nope/1021'), '/reports/income');
  assert.equal(to('/company'), '/company/profile');
  assert.equal(to('/nowhere/at/all'), '/receipts');
  assert.equal(to('/journal?q=x&vat=I81'), '/journal?vat=I81&q=x');
  assert.equal(to('/journal?period=2026-Q9'), '/journal');
  assert.equal(to('/invoices?status=whatever'), '/invoices');
  assert.equal(to('/receipts?filter=linked'), '/receipts?filter=zugeordnet');
  assert.equal(to('/receipts?filter=unlinked'), '/receipts?filter=offen');
});

test('old /<lang>/<period>/<tab> links redirect to what they named', () => {
  const OLD: Array<[string, string]> = [
    ['/de', '/receipts'],
    ['/fr/receipts', '/receipts'],
    ['/de/2026-Q3/receipts?receipt=3f2a9c01b7d4e5f6', '/receipts/3f2a9c01b7d4e5f6?period=2026-Q3'],
    ['/receipts?receipt=3f2a9c01b7d4e5f6&filter=linked&q=coop', '/receipts/3f2a9c01b7d4e5f6?filter=zugeordnet&q=coop'],
    ['/de/2026-Q3/receipts?filter=unlinked', '/receipts?period=2026-Q3&filter=offen'],
    ['/de/2026-Q3/transactions?tx=ZKB-4711', '/payments/ZKB-4711?period=2026-Q3'],
    ['/de/transactions', '/bank'],
    ['/it/2026-09/bank-statements?statement=zkb%2Fsept.pdf', '/bank?period=2026-09'],
    ['/de/bank-reconciliation', '/bank'],
    ['/en/2026/journal-entries?je=M2026-001', '/journal/M2026-001?period=2026'],
    ['/2026-Q1/journal-entries', '/journal?period=2026-Q1'],
    ['/journal-entries?je=M2026-001', '/journal/M2026-001'],
    ['/de/2026/trial-balance?account=1021', '/reports/trial/1021?period=2026'],
    ['/de/2026/balance-sheet', '/reports/balance?period=2026'],
    ['/de/income-statement?account=3400', '/reports/income/3400'],
    ['/de/2026-Q3/account-ledger?account=1021&je=M2026-001', '/reports/trial/1021?period=2026-Q3'],
    ['/de/2026-Q2/vat-report?ziffer=405', '/vat/405?period=2026-Q2'],
    ['/de/2026-Q2/vat-report?view=codes&code=I81', '/vat/codes/I81?period=2026-Q2'],
    ['/de/2026-Q2/vat-report?view=codes', '/vat/codes?period=2026-Q2'],
    ['/de/year-close', '/close'],
    ['/de/2026-10-01..2026-10-09/journal-entries', '/journal?period=2026-10-01_2026-10-09'],
    ['/de/ytd/journal-entries', '/journal?period=ytd'],
    ['/de/all/receipts', '/receipts?period=all'],
    ['/de/2026-Q3/nonsense', '/receipts?period=2026-Q3'],
  ];
  for (const [old, now] of OLD) {
    const p = parse(old);
    assert.ok(isRedirect(p), `${old} should redirect`);
    assert.equal(formatLocation(p.redirect), now, old);
    assert.ok(!isRedirect(parse(now)), `${now} is canonical`);
  }
});
