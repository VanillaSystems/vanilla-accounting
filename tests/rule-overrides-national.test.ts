/**
 * A company rule that books against a national VAT rule (issue #75): the card says so in words,
 * names the payments, and «Behalten» keeps it only with the person's confirmation
 * (src/booking/national-vat.ts, src/saving/rules.ts keepDraft). A rule that agrees shows nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { draftDir } from '../src/saving/changes.js';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { draftRules, keepDraft } from '../src/saving/rules.js';
import type { JournalEntry, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';

/** A keep's outcome without what it booked and its undo (#383). */
const pick = (r: { ok: boolean; committed?: boolean }) => ({ ok: r.ok, committed: r.committed });

process.env.GIT_AUTHOR_NAME = 'Erika Beispiel';
process.env.GIT_AUTHOR_EMAIL = 'erika@example.com';
process.env.GIT_COMMITTER_NAME = 'Erika Beispiel';
process.env.GIT_COMMITTER_EMAIL = 'erika@example.com';

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const BEFORE = `process: booking
steps:
  classify:
    rules: []
`;
const rule = (account: string, vat: string) => `process: booking
steps:
  classify:
    rules:
      - id: adplatform
        when: { text: "Adplatform Ltd", direction: out }
        then: { account: "${account}", vat: ${vat} }
        source: correction 2026-10-20
`;

async function company(): Promise<Workspace> {
  const repo = mkdtempSync(join(tmpdir(), 'rule-national-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  const ws = workspaceAt(join(repo, APP_FOLDER));
  mkdirSync(join(ws.paths.root, 'knowledge/rules'), { recursive: true });
  writeFileSync(join(ws.paths.root, GUIDE), BEFORE);
  await initRepository(repo, 'Workspace set up');
  return ws;
}

function draft(ws: Workspace, text: string): void {
  mkdirSync(dirname(join(draftDir(ws), GUIDE)), { recursive: true });
  writeFileSync(join(draftDir(ws), GUIDE), text);
}

/**
 * `n` payments to the ad platform of the open quarter, each with its receipt (`receipt` its VAT
 * facts) linked and booked today as `booked` says.
 */
function payments(ws: Workspace, n: number, receipt: Partial<Receipt>, booked: (i: number) => Partial<JournalEntry>): void {
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    for (let i = 0; i < n; i++) {
      const ref = `ADP-${i}`;
      const date = `2026-10-0${i + 1}`;
      b.transactions.push({ ref, bank: 'Raiffeisen', date, amount: 100 + i, currency: 'CHF', direction: 'DBIT', description: 'Adplatform Ltd, Kampagne' });
      b.receipts.push({ id: `adp-r${i}`, filename: `adp-${i}.pdf`, originalFilename: `adp-${i}.pdf`, extractedText: 'Adplatform Ltd invoice', extractionMethod: 'pdftotext', fileSize: 1, indexedAt: '2026-10-10T00:00:00Z', location: 'archived', date, amount: 100 + i, currency: 'CHF', ...receipt });
      b.mappings.push({ transactionRef: ref, receiptId: `adp-r${i}`, by: 'human' });
      b.journalEntries.push({ id: `adp-e${i}`, transactionRef: ref, date, accountDebit: '6570', accountCredit: '1021', amount: 100 + i, description: 'Adplatform', origin: 'classify', ...booked(i) });
    }
  });
  saveBooks(ws, books);
}

const foreignNoVat: Partial<Receipt> = { hasSwissVat: false, vatSummary: [] };
const appBezugsteuer = () => ({ vatCode: 'B81-1', by: { kind: 'code', check: 'acquisitionTax' } }) as const;

test('a rule booking a foreign ad platform without Bezugsteuer warns, names the payments, and keeps only with the confirmation', async () => {
  const ws = await company();
  payments(ws, 6, foreignNoVat, appBezugsteuer);
  draft(ws, rule('6570', 'I0'));
  const d = draftRules(ws, GUIDE)!;
  const [p] = d.preview;
  assert.deepEqual(p.overrides?.map((o) => [o.kind, o.count, o.payments.length]), [['withoutAcquisition', 6, 5]]);
  assert.deepEqual(p.overrides![0].payments[0].would, { kind: 'book', lines: [{ account: '6570', vat: 'I0', amount: 105 }] });
  assert.deepEqual(p.overrides![0].payments[0].national, [{ account: '6570', vat: 'B81-1', amount: 105 }], 'the line the national rule gives');
  assert.deepEqual([d.overrides.map((r) => r.id), d.wide, d.spread, d.keepable, d.confirm], [['adplatform'], [], [], true, true]);

  const refused = await keepDraft(ws, GUIDE, d.basis);
  assert.deepEqual([refused.ok, (refused as { refusal: string }).refusal], [false, 'wide']);
  assert.match((refused as { message: string }).message, /adplatform.*Steuerregeln des Landes/);
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), BEFORE, 'nothing kept without the confirmation');
  assert.deepEqual(pick(await keepDraft(ws, GUIDE, d.basis, true)), { ok: true, committed: true });
  assert.equal(readFileSync(join(ws.paths.root, GUIDE), 'utf8'), rule('6570', 'I0'), '«Trotzdem behalten»');
});

test('the supply and supplier country the model read, kept on its entries, warn on a payment never booked with Bezugsteuer (#80)', async () => {
  const ws = await company();
  payments(ws, 2, foreignNoVat, () => ({ vatCode: 'I0', by: { kind: 'model', model: 'm' }, supply: 'service', supplierCountry: 'IE' }));
  draft(ws, rule('6570', 'I0'));
  const [o] = draftRules(ws, GUIDE)!.preview[0].overrides ?? [];
  assert.deepEqual([o?.kind, o?.count, o?.payments[0].national[0].vat], ['withoutAcquisition', 2, 'B81-1']);
});

test('the model\'s reading of goods from abroad, or none kept at all, gives no Bezugsteuer warning (#80)', async () => {
  for (const kept of [{ supply: 'goods', supplierCountry: 'IE' }, {}] as const) {
    const ws = await company();
    payments(ws, 1, foreignNoVat, () => ({ vatCode: 'I0', by: { kind: 'model', model: 'm' }, ...kept }));
    draft(ws, rule('6570', 'I0'));
    assert.equal(draftRules(ws, GUIDE)!.preview[0].overrides, undefined, JSON.stringify(kept));
  }
});

test('a person who changed the app\'s Bezugsteuer to I0 is warned too: the code was B81-1 before', async () => {
  const ws = await company();
  payments(ws, 2, foreignNoVat, () => ({ vatCode: 'I0', origin: 'manual', by: { kind: 'person', at: '2026-10-20T10:00:00Z', was: { vatCode: 'B81-1' } } }));
  draft(ws, rule('6570', 'I0'));
  assert.deepEqual(draftRules(ws, GUIDE)!.preview[0].overrides?.map((o) => [o.kind, o.count]), [['withoutAcquisition', 2]]);
});

test('a rule that books what the national rules give shows nothing new and keeps with one click', async () => {
  const ws = await company();
  payments(ws, 3, foreignNoVat, appBezugsteuer);
  draft(ws, rule('6570', 'B81-1'));
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.preview[0].matches, d.preview[0].overrides, d.overrides, d.confirm], [3, undefined, [], false]);
  assert.equal((await keepDraft(ws, GUIDE, d.basis)).ok, true);
});

test('a rule claiming input tax where no receipt shows a Swiss rate warns', async () => {
  const ws = await company();
  // The invoice says MWST but no rate was read from it, so nothing proves the input tax (pv-no-receipt).
  payments(ws, 2, { hasSwissVat: true, vatSummary: [] }, () => ({ vatCode: 'I0', by: { kind: 'model', model: 'm' } }));
  draft(ws, rule('6570', 'I81'));
  const d = draftRules(ws, GUIDE)!;
  const [o] = d.preview[0].overrides ?? [];
  assert.deepEqual([o?.kind, o?.count, o?.payments[0].would.lines[0].vat, o?.payments[0].national[0].vat], ['inputTaxWithoutReceipt', 2, 'I81', 'I0']);
  assert.equal(d.confirm, true);
});

test('a rule\'s rate code with only a delivery note linked books the zero code itself, as the national rules do: no warning (#81)', async () => {
  const ws = await company();
  payments(ws, 2, { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 7.5 }], kind: 'supporting' }, () => ({ vatCode: 'I0', by: { kind: 'model', model: 'm' } }));
  draft(ws, rule('6570', 'I81'));
  const d = draftRules(ws, GUIDE)!;
  assert.deepEqual([d.preview[0].examples[0].would, d.preview[0].overrides ?? [], d.confirm], [{ kind: 'book', lines: [{ account: '6570', vat: 'I0', amount: 101 }] }, [], false]);
});

test('a rule booking without input tax where the receipt shows Swiss VAT on the whole amount warns', async () => {
  const ws = await company();
  payments(ws, 1, { hasSwissVat: true, vatId: 'CHE-123.456.789', vatSummary: [{ ratePercent: 8.1, gross: 100, vat: 7.49 }] }, () => ({ vatCode: 'I81', by: { kind: 'model', model: 'm' } }));
  draft(ws, rule('6570', 'I0'));
  assert.deepEqual(draftRules(ws, GUIDE)!.preview[0].overrides?.map((o) => [o.kind, o.payments[0].national[0].vat]), [['inputTaxForgone', 'I81']]);
});

test('a firm not registered for VAT is never warned: the national rules give no code', async () => {
  const ws = await company();
  payments(ws, 2, foreignNoVat, appBezugsteuer);
  const manifest = join(ws.paths.root, 'belege.workspace.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^  vat: .*$/m, '  vat: { registered: false }'));
  draft(ws, rule('6570', 'none'));
  const d = draftRules(workspaceAt(ws.paths.root), GUIDE)!;
  assert.deepEqual([d.preview[0].matches, d.preview[0].overrides], [2, undefined]);
});
