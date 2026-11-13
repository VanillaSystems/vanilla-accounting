/**
 * Issue #453, in the real UI: a drop of many files (the consultancy persona's 43) shows its head,
 * its overview, its list and its foot each in its own place and inside the dialog, at the narrowest
 * window the Mac app allows (900 × 600) and a wide one, while worked on and at its end; before, the
 * line «Gesamt 51 % · 1 von 43 Dateien fertig» was drawn over the tabs, and at the end «Schliessen»
 * lay below the dialog. The overview counts the rows by the state each row shows, each count a
 * filter of the list, and says what is done now with the files worked on; what needs her is listed
 * first, the files worked on or done are folded into a line with their count; the counts follow the
 * session live, a filter whose last file left it gives way to «alle», and the overview stays for the
 * session. The drop's session is the server's answer, made up here so the rows stand still while the
 * boxes are measured: 41 receipts whose run is not in the poll (worked on), 3 files being taken, a
 * ZIP that asks its password, a file the books hold already.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { noBrowser, openApp } from './support/e2e.js';
import type { DropRow } from '../src/types/drop.js';

const working = Array.from({ length: 41 }, (_, i): DropRow => ({ key: `r${i}`, id: `r${i}`, name: `Rechnung_${String(i + 1).padStart(2, '0')}.pdf`, size: 1, kind: 'receipt', state: 'taken', run: 'run-not-polled-yet' }));
const taking = Array.from({ length: 3 }, (_, i): DropRow => ({ key: `t${i}`, id: `t${i}`, name: `Quittung_${i + 1}.pdf`, size: 1, kind: 'receipt', state: 'take' }));
const locked: DropRow = { key: 'z', id: 'z', name: 'Belege_Q3.zip', size: 1, kind: 'zip', state: 'locked' };
const known: DropRow = { key: 'k', id: 'k', name: 'Alpentel_Rechnung_2026-07.pdf', size: 1, kind: 'receipt', state: 'duplicate', reason: 'duplicate' };
const ROWS = [locked, ...taking, ...working, known];

/**
 * A drop at its end: nothing worked on; a ZIP and two statements that ask; files the books hold, no
 * receipt, set aside, refused and taken back: each closing sentence and each hint below the list is
 * there, as long as a real drop's end at the narrowest window.
 */
const END: DropRow[] = [
  locked,
  { key: 'a1', id: 'a1', name: 'Kontoauszug_Juli.pdf', size: 1, kind: 'statement-pdf', state: 'asks', asked: { file: 'Bank/Kontoauszug_Juli.pdf', month: '2026-07' } },
  { key: 'a2', id: 'a2', name: 'Kontoauszug_August.pdf', size: 1, kind: 'statement-pdf', state: 'asks', reason: 'not-imported' },
  { key: 'q1', id: 'q1', name: 'Ferien.jpg', size: 1, kind: 'photo', state: 'quarantine', reason: 'not-receipt' },
  { key: 'q2', id: 'q2', name: 'Kaputt.pdf', size: 1, kind: 'receipt', state: 'quarantine', reason: 'unreadable' },
  { key: 'x1', id: 'x1', name: 'Offerte.docx', size: 1, state: 'refused', reason: 'office' },
  { key: 'u1', id: 'u1', name: 'Zurueck.pdf', size: 1, kind: 'receipt', state: 'undone' },
  { key: 'p1', id: 'p1', name: 'Vielleicht.pdf', size: 1, kind: 'receipt', state: 'duplicate', reason: 'possible-duplicate', twin: { of: 'orig', name: 'Original.pdf', relation: 'duplicate', why: 'same-text' } },
  ...Array.from({ length: 40 }, (_, i): DropRow => ({ ...known, key: `k${i}`, id: `k${i}`, name: `Alt_${i + 1}.pdf` })),
];

/** Answers the drop window's requests with the made-up session `session()`; it may change between answers. */
async function fakeDrop(page: Page, session: () => { id: string; rows: DropRow[] }): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith('/api/drop')) { void r.continue(); return; }
    // A file the server cannot take (a lost connection): the window names it in a line of its own, one more line below the list.
    if (new URL(r.url()).searchParams.get('name') === 'Kaputt.pdf') { void r.respond({ status: 500, contentType: 'application/json', body: '{"error":"Verbindung unterbrochen"}' }); return; }
    if (r.method() === 'DELETE') { void r.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); return; }
    void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(session()) });
  });
}

/** The dialog's parts: each direct child with all it draws (its overflow included, unless it scrolls), and the dialog's own box. */
const parts = (page: Page) => page.evaluate(() => {
  const dlg = document.querySelector('[data-testid=drop-dialog]')!;
  const box = dlg.getBoundingClientRect();
  const of = [...dlg.children].filter((e) => (e as HTMLElement).offsetParent !== null).map((part) => {
    const scrolls = getComputedStyle(part).overflowY === 'auto';
    const rects = [part, ...(scrolls ? [] : part.querySelectorAll('*'))].map((e) => e.getBoundingClientRect()).filter((b) => b.width && b.height);
    return { name: `${part.tagName.toLowerCase()}.${(part as HTMLElement).className}`, top: Math.min(...rects.map((b) => b.top)), bottom: Math.max(...rects.map((b) => b.bottom)) };
  });
  return { top: box.top, bottom: box.bottom, parts: of };
});

/** Every part that lies over another, and every part not inside the dialog. */
async function misplaced(page: Page): Promise<string[]> {
  const { top, bottom, parts: ps } = await parts(page);
  const out: string[] = [];
  const at = (p: { name: string; top: number; bottom: number }) => `${p.name} [${Math.round(p.top)}–${Math.round(p.bottom)}]`;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].top < top - 0.5 || ps[i].bottom > bottom + 0.5) out.push(`${at(ps[i])} outside the dialog [${Math.round(top)}–${Math.round(bottom)}]`);
    for (let j = i + 1; j < ps.length; j++) if (ps[i].top < ps[j].bottom - 0.5 && ps[j].top < ps[i].bottom - 0.5) out.push(`${at(ps[i])} over ${at(ps[j])}`);
  }
  return out;
}

const WIDTHS = [[900, 600], [1440, 900]] as const;
async function placedAtEveryWidth(page: Page, state: string): Promise<void> {
  for (const [width, height] of WIDTHS) {
    await page.setViewport({ width, height });
    await new Promise((r) => setTimeout(r, 300));
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `drop-many-${state}-${width}.png`) });
    assert.deepEqual(await misplaced(page), [], `${state}, ${width} × ${height}: every part of the dialog in its own place, inside it`);
  }
}

const filters = (page: Page) => page.$$eval('[data-testid=drop-filter]', (bs) => bs.map((b) => ({ name: (b.getAttribute('aria-label') ?? (b as HTMLElement).innerText).replace(/\s+/g, ' ').trim(), stage: (b as HTMLElement).dataset.stage, pressed: b.getAttribute('aria-pressed') })));
const listed = (page: Page) => page.$$eval('[data-testid=drop-row]', (rs) => rs.map((r) => (r as HTMLElement).dataset.file));
const dropOne = (page: Page, names = ['Rechnung_01.pdf']) => page.evaluate((names) => {
  const dt = new DataTransfer();
  for (const name of names) dt.items.add(new File(['%PDF-1.4'], name, { type: 'application/pdf' }));
  dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
}, names);

test('a drop of many files: every part in its place, the overview counts and filters the rows, live, while worked on and at its end', { skip: noBrowser, timeout: 400_000 }, async () => {
  const app = await openApp();
  const { page } = app;
  let session = { id: 'many', rows: ROWS };
  try {
    await fakeDrop(page, () => session);
    await app.open('/bank?period=2026-Q3', '#root > *');
    await dropOne(page);
    await page.waitForFunction(() => document.querySelector('[data-testid=drop-dialog]')?.textContent?.includes('Belege_Q3.zip'), { timeout: 60_000 });
    await placedAtEveryWidth(page, 'working');

    // The overview: one bar with its value, the line saying what is done now, the stages counted from the rows, each a button with its count in its name.
    const bar = await page.$eval('[data-testid=drop-overview] [role=progressbar]', (b) => b.getAttribute('aria-valuenow'));
    assert.match(bar ?? '', /^\d+$/, 'the bar has a value');
    const line = await page.$eval('[data-testid=drop-overall]', (p) => ({ text: (p as HTMLElement).innerText, live: p.getAttribute('aria-live') }));
    assert.deepEqual(line, { text: 'Gesamt 4 % · 2 von 46 Dateien fertig · 3 werden hochgeladen · 41 in Arbeit', live: 'polite' }, 'what is done now, the parts at 0 left out');
    assert.deepEqual((await filters(page)).map((f) => f.name), ['46 Dateien', '1 braucht dich', '44 in Arbeit', '1 nicht in den Büchern'], 'stages without files are not shown');
    assert.equal(await page.$$eval('[data-testid=drop-dialog] .wftabs', (t) => t.length), 0, 'the tabs are folded into the overview\'s filters');
    assert.equal((await page.$eval('[data-testid=drop-dialog]', (d) => (d as HTMLElement).innerText.match(/Gesamt \d+ %/g) ?? [])).length, 1, 'one line says how far the drop is');

    // What needs her comes first, without a second heading; what is worked on or done is a heading with its count, folded.
    assert.deepEqual(await listed(page), ['Belege_Q3.zip']);
    assert.equal(await page.$$eval('.dmid .dgroup[data-stage=needs] .dgh', (h) => h.length), 0, 'the filter above names them');
    const groups = await page.$$eval('[data-testid=drop-group]', (gs) => gs.map((g) => `${(g as HTMLElement).dataset.stage} ${g.getAttribute('aria-expanded')} ${g.parentElement!.tagName} ${!!document.getElementById(g.getAttribute('aria-controls') ?? '')}`));
    assert.deepEqual(groups, ['working false H3 true', 'out false H3 true']);
    await page.click('[data-testid=drop-group][data-stage=out]');
    assert.deepEqual(await listed(page), ['Belege_Q3.zip', 'Alpentel_Rechnung_2026-07.pdf'], 'a folded line opens its rows');

    // A filter shows its rows only, all of them; pressing it again shows the whole drop.
    await page.click('[data-testid=drop-filter][data-stage=working]');
    assert.equal((await listed(page)).length, 44);
    assert.equal((await filters(page)).find((f) => f.stage === 'working')?.pressed, 'true');
    await page.click('[data-testid=drop-filter][data-stage=working]');
    assert.equal((await filters(page)).find((f) => f.stage === 'working')?.pressed, 'false');

    // Live: «braucht dich» filtered, the ZIP taken out; the counts follow, the filter gives way to «alle» and the focus goes there.
    await page.click('[data-testid=drop-filter][data-stage=needs]');
    session = { ...session, rows: ROWS.filter((r) => r !== locked) };
    await page.click('[data-testid=drop-row][data-file="Belege_Q3.zip"] .dx');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-filter][data-stage=needs]'));
    assert.deepEqual((await filters(page)).map((f) => f.name), ['45 Dateien', '44 in Arbeit', '1 nicht in den Büchern']);
    assert.equal((await filters(page)).find((f) => f.stage === 'all')?.pressed, 'true');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.stage), 'all', 'the focus is on «alle»');
    // Fewer than 10 files left: the overview stays for this drop, never back to the tabs under her hand.
    session = { ...session, rows: [known, ...working.slice(0, 4)] };
    await page.click('[data-testid=drop-row][data-file="Alpentel_Rechnung_2026-07.pdf"] .dx');
    await page.waitForFunction(() => document.querySelector('[data-testid=drop-filter][data-stage=all]')?.textContent === '5 Dateien');
    assert.equal(await page.$$eval('[data-testid=drop-dialog] .wftabs', (t) => t.length), 0);

    // At its end: the closing lines, the list and the hints scroll between the overview and «Schliessen».
    await page.click('[data-testid=drop-close]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-dialog]'));
    session = { id: 'end', rows: END };
    await dropOne(page, ['Rechnung_01.pdf', 'Kaputt.pdf']);
    await page.waitForFunction(() => document.querySelector('[data-testid=drop-dialog]')?.getAttribute('data-working') === 'false' && !!document.querySelector('[data-testid=close-hint]') && document.querySelector('[data-testid=drop-dialog]')!.textContent!.includes('Kaputt.pdf'), { timeout: 30_000 });
    await placedAtEveryWidth(page, 'end');
    assert.ok(await page.$('[data-testid=drop-overview] [data-testid=drop-filter]'), 'the filters stay at the end');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

/**
 * A real drop of 14 PDFs (#453 second review): each file taken starts another inbox run, and a
 * later run takes up every receipt still waiting for its payment again. The window judges a row by
 * its own run only: the receipts the first run read stay at rest while the second run works, the bar
 * never goes back and the counts do not swing. Before, «Gesamt 50 % · 7 von 14» fell to «0 von 14».
 */
test('a second run of the same drop does not set the files at rest back to «in Arbeit»', { skip: noBrowser, timeout: 400_000 }, async () => {
  const app = await openApp();
  const { page, api } = app;
  try {
    const books = await (await api.fetch('/books.json')).json() as { receipts: Array<Record<string, unknown>> };
    const view = (await api.send('GET', '/api/automation')).json;
    // Seven receipts the first run read, staged, waiting for their payment.
    const read = Array.from({ length: 7 }, (_, i) => ({ ...books.receipts[0], id: `r453read${i}`, filename: `Rechnung_${i + 1}.pdf`, originalFilename: `Rechnung_${i + 1}.pdf`, location: 'staged', kind: 'invoice', date: `2026-08-0${i + 1}`, amount: 100 + i, currency: 'CHF' }));
    const run = (id: string, status: string, startedAt: string, files: string[], at?: string) => ({
      id, workflow: 'receipt-intake', item: { kind: 'file', id }, mode: 'live', startedAt, status, path: at ? [at] : ['read', 'facts', 'match', 'book'], ...(at ? { at } : {}),
      startedBy: { kind: 'outside', file: files[0] }, arrived: files.map((file, i) => ({ kind: 'receipt', file, id: id === 'run-1' ? `r453read${i}` : `r453new${i}` })),
      digest: { files, receipts: files.length, links: 0, entries: 0, poorScans: [] },
    });
    const first = run('run-1', 'done', '2026-11-13T10:00:00Z', read.map((r) => r.filename));
    const newer = Array.from({ length: 7 }, (_, i) => `Neu_${i + 1}.pdf`);
    const second = run('run-2', 'running', '2026-11-13T10:01:00Z', newer, 'read');
    let runs = [first];
    let rows: DropRow[] = [
      ...read.map((r): DropRow => ({ key: r.id, id: r.id, name: r.filename, size: 1, kind: 'receipt', state: 'taken', run: 'run-1' })),
      ...newer.map((name, i): DropRow => ({ key: `n${i}`, id: `r453new${i}`, name, size: 1, kind: 'receipt', state: 'take' })),
    ];
    let rev = 0;
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      const json = (body: unknown) => void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/books.json') json({ ...books, receipts: [...books.receipts, ...read] });
      else if (path === '/api/automation') json({ ...view, rev: `fake-${rev}`, runs });
      else if (path.startsWith('/api/drop')) json(r.method() === 'DELETE' ? { ok: true } : { id: 'two-runs', rows });
      else void r.continue();
    });
    await app.open('/receipts?period=2026-Q3', '#root > *');
    await dropOne(page);
    await page.waitForFunction(() => /Gesamt 50 %/.test(document.querySelector('[data-testid=drop-overall]')?.textContent ?? ''), { timeout: 30_000 });
    const seen = async () => ({
      line: await page.$eval('[data-testid=drop-overall]', (p) => (p as HTMLElement).innerText),
      stages: await page.$$eval('[data-testid=drop-filter]', (bs) => bs.map((b) => (b as HTMLElement).innerText.trim())),
    });
    const before = await seen();
    assert.deepEqual(before.stages, ['14 Dateien', '7 in Arbeit', '7 warten auf ihre Zahlung']);

    // The newer files taken (the server's next answer), their run reads them; the first seven stay where they were.
    runs = [first, second];
    rev++;
    rows = rows.map((r) => (r.state === 'take' ? { ...r, state: 'taken', run: 'run-2' } : r));
    await dropOne(page, ['Neu_8.pdf']);
    // No focus and no 10 s wait of a quiet app: taking files asks at once, and every 2 s while they are worked on.
    await page.waitForFunction(() => /werden gelesen/.test(document.querySelector('[data-testid=drop-overall]')?.textContent ?? ''), { timeout: 5_000 });
    const after = await seen();
    assert.deepEqual(after.stages, ['14 Dateien', '7 in Arbeit', '7 warten auf ihre Zahlung'], 'the counts do not swing');
    const pct = (line: string) => Number(/Gesamt (\d+) %/.exec(line)![1]);
    assert.ok(pct(after.line) >= pct(before.line), `the bar never goes back: ${before.line} → ${after.line}`);
    assert.match(after.line, /7 von 14 Dateien fertig · 7 werden gelesen/);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
