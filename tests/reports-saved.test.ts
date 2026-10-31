/**
 * Saved reports (src/reports/saved.ts, POST /api/reports/saved): one file per report under
 * knowledge/reports/, the spec and never its figures; a second report of the same title gets a
 * slug of its own, an edit keeps its slug, a delete and a save are undone by the text they
 * answer, and an undo is refused once the file changed since. The file is the company's
 * customizing, so Änderungen lists it until it is saved. A saved report runs for any period.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FOLDER, workspaceAt } from '../src/workspace/workspace.js';
import { initRepository } from '../src/workspace/git.js';
import { outsideChanges } from '../src/saving/changes.js';
import { parseSpec, type ReportSpec } from '../src/reports/spec.js';
import { deleteReport, listSaved, reportPath, restoreReport, saveReport } from '../src/reports/saved.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';
import { formatLocation, parseLocation } from '../src/app/shell/route.js';
import { parsePeriod } from '../src/accounting/periods.js';

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';
process.env.GIT_COMMITTER_NAME = 'Erika Beispiel';
process.env.GIT_COMMITTER_EMAIL = 'erika@example.com';

const RAW = { title: 'Spesen nach Konto', period: '2026-Q3', sections: [{ source: 'entries', filter: { accounts: ['6000-6999'] }, group: 'account' }], comment: 'Zusammen {total}.' };
const spec = (raw: unknown = RAW): ReportSpec => { const p = parseSpec(raw, '2026-10-16'); assert.ok(p.ok); return p.value; };

async function company() {
  const repo = mkdtempSync(join(tmpdir(), 'reports-saved-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  await initRepository(repo, 'Workspace set up');
  return workspaceAt(join(repo, APP_FOLDER));
}

test('a report is saved as its spec in its own file, read back the same; the same title again gets a slug of its own, an edit keeps its slug', async () => {
  const ws = await company();
  const w = saveReport(ws, spec());
  assert.deepEqual([w.slug, w.path, w.before], ['spesen-nach-konto', 'knowledge/reports/spesen-nach-konto.report.yaml', null]);
  const text = readFileSync(join(ws.paths.root, w.path), 'utf8');
  assert.match(text, /accounts:\n +- 6000-6999/);
  assert.doesNotMatch(text.replace(/^#.*\n/, ''), /\d+\.\d\d/, 'no figure in the file');
  assert.deepEqual(listSaved(ws), [{ slug: w.slug, path: w.path, spec: spec() }]);
  assert.equal(saveReport(ws, spec()).slug, 'spesen-nach-konto-2');
  const edited = saveReport(ws, spec({ ...RAW, period: '2026-Q2' }), w.slug);
  assert.equal(edited.slug, w.slug);
  assert.equal(edited.before, text, 'an edit answers the file as it was');
  assert.equal((listSaved(ws)[0] as { spec: ReportSpec }).spec.period, '2026-Q2');
});

test('delete and save are undone by the text they answer; an undo once the file changed since is refused', async () => {
  const ws = await company();
  const made = saveReport(ws, spec());
  const gone = deleteReport(ws, made.slug)!;
  assert.equal(listSaved(ws).length, 0);
  assert.ok(restoreReport(ws, gone.slug, gone.before, gone.after), 'the delete undone');
  assert.equal(listSaved(ws).length, 1);
  assert.ok(restoreReport(ws, made.slug, made.before, made.after), 'the save undone: the file is gone again');
  assert.equal(existsSync(join(ws.paths.root, made.path)), false);
  const again = saveReport(ws, spec());
  saveReport(ws, spec({ ...RAW, title: 'Spesen nach Konto', period: '2026' }), again.slug);
  assert.equal(restoreReport(ws, again.slug, again.before, again.after), undefined, 'changed since: nothing taken back');
  assert.equal(deleteReport(ws, 'gibts-nicht'), undefined);
});

test('a file the app cannot read is listed with why', async () => {
  const ws = await company();
  mkdirSync(join(ws.paths.root, 'knowledge/reports'), { recursive: true });
  writeFileSync(join(ws.paths.root, reportPath('kaputt')), 'title: Kaputt\nperiod: Q9\nsections: [{ source: entries }]\n');
  assert.deepEqual(listSaved(ws), [{ slug: 'kaputt', path: 'knowledge/reports/kaputt.report.yaml', refusal: { code: 'period', params: { period: 'Q9' } } }]);
});

test('Änderungen lists a saved report as a change of the company\'s customizing until it is saved, and not after its undo', async () => {
  const ws = await company();
  const w = saveReport(ws, spec());
  assert.deepEqual((await outsideChanges(ws)).map((f) => [f.path, f.state]), [[w.path, 'added']]);
  restoreReport(ws, w.slug, w.before, w.after);
  assert.deepEqual(await outsideChanges(ws), []);
});

test('POST /api/reports/saved saves, lists, deletes and restores; a spec the chart refuses is not saved; a saved report runs for another period', async () => {
  const api = await startApi('demo/vanilla-accounting');
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  try {
    const saved = await api.send('POST', '/api/reports/saved', { kind: 'save', spec: RAW });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const listed = await api.send('GET', '/api/reports/saved');
    assert.deepEqual((listed.json.reports as Array<{ slug: string }>).map((r) => r.slug), ['spesen-nach-konto']);
    const bad = await api.send('POST', '/api/reports/saved', { kind: 'save', spec: { ...RAW, sections: [{ source: 'entries', filter: { accounts: ['6599'] } }] } });
    assert.deepEqual([bad.status, bad.json.code], [400, 'report']);
    const q2 = await api.send('POST', '/api/reports/run', { spec: (listed.json.reports as Array<{ spec: unknown }>)[0].spec, period: '2026-Q2' });
    const q3 = await api.send('POST', '/api/reports/run', { spec: RAW });
    const period = (r: typeof q2) => (r.json.result as { period: { token: string } }).period.token;
    assert.deepEqual([period(q2), period(q3)], ['2026-Q2', '2026-Q3'], 'one spec, two periods');
    assert.notDeepEqual((q2.json.result as { totals: unknown }).totals, (q3.json.result as { totals: unknown }).totals);
    const gone = await api.send('POST', '/api/reports/saved', { kind: 'delete', slug: 'spesen-nach-konto' });
    assert.equal(gone.status, 200);
    const back = await api.send('POST', '/api/reports/saved', { kind: 'restore', slug: 'spesen-nach-konto', text: gone.json.before, now: null });
    assert.equal(back.status, 200);
    assert.equal(((await api.send('GET', '/api/reports/saved')).json.reports as unknown[]).length, 1);
    const stale = await api.send('POST', '/api/reports/saved', { kind: 'restore', slug: 'spesen-nach-konto', text: null, now: 'anders' });
    assert.equal(stale.status, 409);
  } finally {
    await api.stop();
  }
  const audit = await startApi('demo/vanilla-accounting', { READONLY: '1' });
  try {
    assert.equal((await audit.send('POST', '/api/reports/saved', { kind: 'save', spec: RAW })).status, 403, 'audit mode saves nothing');
  } finally {
    await audit.stop();
  }
});

test('a saved report has a link: /reports/custom/<slug>, and /reports/custom is the list', () => {
  assert.deepEqual(parseLocation('/reports/custom/spesen-nach-konto', '', '2026-10-16'), { route: { area: 'reports', report: 'custom', saved: 'spesen-nach-konto' }, query: {} });
  assert.deepEqual(parseLocation('/reports/custom', '?period=2026-Q2', '2026-10-16'), { route: { area: 'reports', report: 'custom' }, query: { period: parsePeriod('2026-Q2', '2026-10-16')! } });
  assert.equal(formatLocation({ route: { area: 'reports', report: 'custom', saved: 'x' }, query: {} }), '/reports/custom/x');
});
